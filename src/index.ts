/**
 * @buzz/mcp — TypeScript MCP server for the CorePrt Nostr relay.
 *
 * PR #3 introduced the first MCP tool (`buzz_post_message`).
 * PR #4 added 12 more (identity, channels, message edits/reactions,
 * fetch + search, jobs + workflow approvals, media upload, thread summaries).
 * PR #5 adds the WebSocket subscription manager + 3 tools
 * (`buzz_subscribe`, `buzz_unsubscribe`, `buzz_poll`).
 * PR #6 will add docs.
 * Phase 1 (multi-relay plan) adds:
 *   - `parseEnv()` schema validation in `src/config/schema.ts` — bad config
 *     fails the server boot with a clear error.
 *   - `BUZZ_MCP_MODE` enforcement (`read-only`, `mutate-with-confirm`,
 *     `mutate`) plumbed through every write tool via `gateWrite`.
 *   - `dryRun: true` per write tool.
 *   - `BUZZ_RELAY_ALLOWED` per-call allowlist.
 * Phase 3 will add the `RelayPool` that consumes `config.relays`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type BuzzConfig, parseEnv } from "./config/schema.js";
import { MultiRelaySubscriptionManager } from "./relay/multi-subscription.js";
import { RelayPool } from "./relay/pool.js";
import type { NsecOrHex } from "./relay/signer.js";
import { StatsStore } from "./relay/stats.js";
import { SubscriptionManager } from "./relay/subscription.js";
import { registerFetchEventsTool, registerSearchTool } from "./tools/fetch.js";
import {
  registerAddMemberTool,
  registerCreateChannelTool,
  registerIdentityTool,
  registerListChannelsTool,
} from "./tools/identity.js";
import { registerApproveWorkflowTool, registerCreateJobTool } from "./tools/jobs.js";
import { registerUploadMediaTool } from "./tools/media.js";
import {
  registerEditMessageTool,
  registerPostMessageTool,
  registerReactTool,
} from "./tools/messages.js";
import { registerGetStatsTool } from "./tools/stats.js";
import {
  registerPollTool,
  registerSubscribeTool,
  registerUnsubscribeTool,
} from "./tools/subscribe.js";
import { registerPostThreadSummaryTool } from "./tools/summaries.js";
import { createLogger, setLogger } from "./util/log.js";
import type { CfAccess } from "./util/relay-call.js";

const SERVER_NAME = "@buzz/mcp";
const SERVER_VERSION = "0.1.6";

/**
 * All 16 tool names registered by this build, in alphabetical order. Kept
 * here as a single source of truth so the MCP `instructions` string and the
 * `test/index.spec.ts` assertion can both reference it.
 *
 * PR #5 added the 3 subscription tools:
 *   - buzz_subscribe   (opens a REQ against the WS)
 *   - buzz_unsubscribe (CLOSE + drop from local map)
 *   - buzz_poll        (drain buffered EVENT frames)
 */
export const REGISTERED_TOOLS: string[] = [
  "buzz_add_member",
  "buzz_approve_workflow",
  "buzz_create_channel",
  "buzz_create_job",
  "buzz_edit_message",
  "buzz_get_stats",
  "buzz_fetch_events",
  "buzz_identity",
  "buzz_list_channels",
  "buzz_poll",
  "buzz_post_message",
  "buzz_post_thread_summary",
  "buzz_react",
  "buzz_search",
  "buzz_subscribe",
  "buzz_unsubscribe",
  "buzz_upload_media",
];

function buildInstructions(config: BuzzConfig, tools: string[]): string {
  const modeNote =
    config.mode === "mutate-with-confirm"
      ? " (write tools return pending-confirm unless caller passes confirm: true)"
      : config.mode === "read-only"
        ? " (write tools refuse at dispatch)"
        : " (write tools sign and post immediately)";
  return [
    "@buzz/mcp is an MCP server for the CorePrt Nostr relay.",
    "",
    `Relay (default): ${config.defaultRelay}`,
    `Relays configured: ${config.relays.length}`,
    `Mode: ${config.mode}${modeNote}`,
    `Cloudflare Access: ${config.cfAccess !== undefined ? "forwarded (service token present)" : "not in path"}`,
    `Write allowlist: ${config.relayAllowed === undefined ? "unset (all configured relays allowed)" : `${config.relayAllowed.length} allowed`}`,
    "",
    "Tools registered in this build:",
    ...tools.map((t) => `  - ${t}`),
    "",
    "All signed writes go through the operator's BUZZ_PRIVATE_KEY env var.",
    "The key is read once at createServer() time and never re-read.",
    "When CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET are both set, every",
    "signedFetch also forwards CF-Access-Client-Id + CF-Access-Client-Secret",
    "headers so the request survives the Cloudflare Access gate in front of",
    "the relay. The secret value itself never appears in tool-result payloads",
    "or logs.",
    "",
    "Subscriptions (buzz_subscribe / buzz_unsubscribe / buzz_poll) share a",
    "single WebSocket connection. They are pull-only — events are buffered",
    "per sub_id and drained by buzz_poll; nothing is pushed back through MCP",
    "notifications/*.",
  ].join("\n");
}

/**
 * Construct a fresh McpServer instance.
 *
 * Phase 1 (this PR): env validation is centralized in `parseEnv()`. The
 * server refuses to start on bad config — missing `BUZZ_PRIVATE_KEY`,
 * malformed `BUZZ_RELAY_URLS`, wrong-format secret, etc. all surface as a
 * thrown `ZodError` at startup, not as a silent partial-config later.
 *
 * The relay URL defaults to "https://coreprt.webrnds.com" if neither
 * `BUZZ_RELAY_URL` nor `BUZZ_RELAY_URLS` is set. Phase 3 (multi-relay)
 * will iterate over `config.relays`; Phase 1 only validates the env.
 *
 * CF Access: when BOTH `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
 * are non-empty, every `signedFetch` automatically forwards
 * `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. If either is
 * missing, the CF-Access layer is bypassed (preserves the local-relay dev
 * case). The credentials are read once at startup; the secret value is
 * never logged or returned in tool-result payloads.
 *
 * PR #5: creates a singleton `SubscriptionManager` per server instance and
 * shares it across `buzz_subscribe` / `buzz_unsubscribe` / `buzz_poll`. The
 * WS connection is lazy — it does NOT open at `createServer()` time, only on
 * the first `buzz_subscribe` call.
 */
export function createServer(): McpServer {
  // Centralized env parsing. Throws on bad config; we let the throw
  // propagate so the caller (CLI/RPC startup) sees a clear error.
  const config = parseEnv();

  const secret = config.secret as NsecOrHex;
  const relayUrl = config.defaultRelay;
  const cfAccess: CfAccess | undefined = config.cfAccess;

  // Phase 2: structured logging. The file sink is opt-in via
  // BUZZ_MCP_LOG_FILE. The default path under Buzz.app is opt-in too, via
  // the `BuzzConfig.logFile` field (Phase 2's schema pins it explicitly).
  const logFile = config.logFile;
  const logger = createLogger({
    level: config.logLevel,
    file: logFile,
    defaultContext: { server: SERVER_NAME, version: SERVER_VERSION },
  });
  setLogger(logger);

  // Phase 2: per-relay stats. A single StatsStore is shared by every
  // signed fetch (and Phase 3's RelayPool). The store is process-local.
  const stats = new StatsStore(logger);

  // Phase 3: RelayPool. Owns the relay list, NIP-11 probe, channel cache.
  const pool = new RelayPool({
    relays: config.relays,
    defaultRelay: config.defaultRelay,
    relayHosts: config.relayHosts,
    secret,
    stats,
    cfAccess,
    channelCacheTtlMs: config.channelCacheTtlMs,
  });

  const subs = new MultiRelaySubscriptionManager({
    relayUrls: config.relays,
    createManager: (relay) => {
      // The SubscriptionManager accepts the secret at construction time.
      // We pass the same NsecOrHex + cfAccess so NIP-42 AUTH works.
      return new SubscriptionManager(secret, relay);
    },
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {},
      instructions: buildInstructions(config, REGISTERED_TOOLS),
    },
  );

  registerPostMessageTool(server, secret, relayUrl, cfAccess, config, { stats }, pool);
  registerEditMessageTool(server, secret, relayUrl, cfAccess, config, { stats }, pool);
  registerReactTool(server, secret, relayUrl, cfAccess, config, { stats }, pool);
  registerIdentityTool(server, secret, relayUrl, cfAccess);
  registerListChannelsTool(server, secret, relayUrl, cfAccess);
  registerCreateChannelTool(server, secret, relayUrl, cfAccess, config, { stats });
  registerAddMemberTool(server, secret, relayUrl, cfAccess, config, { stats });
  registerFetchEventsTool(server, secret, relayUrl, cfAccess);
  registerSearchTool(server, secret, relayUrl, cfAccess);
  registerCreateJobTool(server, secret, relayUrl, cfAccess, { stats }, pool);
  registerApproveWorkflowTool(server, secret, relayUrl, cfAccess, { stats }, pool);
  registerUploadMediaTool(server, secret, relayUrl, cfAccess, { stats });
  registerPostThreadSummaryTool(server, secret, relayUrl, cfAccess, { stats }, pool);
  registerSubscribeTool(server, subs, cfAccess);
  registerUnsubscribeTool(server, subs, cfAccess);
  registerPollTool(server, subs, cfAccess);
  registerGetStatsTool(server, stats);

  logger.info("server.start", {
    relay: relayUrl,
    relays: config.relays.length,
    mode: config.mode,
  });

  return server;
}

export type { BuzzConfig, Mode } from "./config/schema.js";
// Re-export parseEnv + ModeSchema + types for tests + downstream consumers.
export { ModeSchema, parseEnv } from "./config/schema.js";
export { SERVER_NAME, SERVER_VERSION };
