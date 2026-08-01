/**
 * @buzz/mcp — TypeScript MCP server for the CorePrt Nostr relay.
 *
 * PR #3 introduced the first MCP tool (`buzz_post_message`).
 * PR #4 added 12 more (identity, channels, message edits/reactions,
 * fetch + search, jobs + workflow approvals, media upload, thread summaries).
 * PR #5 adds the WebSocket subscription manager + 3 tools
 * (`buzz_subscribe`, `buzz_unsubscribe`, `buzz_poll`).
 * PR #6 will add docs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NsecOrHex } from "./relay/signer.js";
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
import {
  registerPollTool,
  registerSubscribeTool,
  registerUnsubscribeTool,
} from "./tools/subscribe.js";
import { registerPostThreadSummaryTool } from "./tools/summaries.js";
import type { CfAccess } from "./util/relay-call.js";

const SERVER_NAME = "@buzz/mcp";
const SERVER_VERSION = "0.1.1";

const DEFAULT_RELAY_URL = "https://coreprt.webrnds.com";

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

function buildInstructions(
  relayUrl: string,
  tools: string[],
  cfAccess: CfAccess | undefined,
): string {
  return [
    "@buzz/mcp is an MCP server for the CorePrt Nostr relay.",
    "",
    `Relay: ${relayUrl}`,
    `Cloudflare Access: ${cfAccess !== undefined ? "forwarded (service token present)" : "not in path"}`,
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
 * Reads `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL`, and the optional
 * `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` env vars at call time.
 * Throws a clear error if `BUZZ_PRIVATE_KEY` is missing.
 *
 * The relay URL defaults to "https://coreprt.webrnds.com" if unset.
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
  const secret = process.env["BUZZ_PRIVATE_KEY"] as NsecOrHex | undefined;
  if (!secret) {
    throw new Error("BUZZ_PRIVATE_KEY is not set. Add it to the env block in ~/.gg/mcp.json.");
  }

  const relayUrl = process.env["BUZZ_RELAY_URL"] ?? DEFAULT_RELAY_URL;

  // Cloudflare Access service-token credentials. Both must be present and
  // non-empty; if either is missing, fall through with `cfAccess = undefined`
  // so the local-relay dev path (no CF Access in front) keeps working.
  const cfClientId = process.env["CF_ACCESS_CLIENT_ID"];
  const cfClientSecret = process.env["CF_ACCESS_CLIENT_SECRET"];
  const cfAccess: CfAccess | undefined =
    cfClientId !== undefined &&
    cfClientId !== "" &&
    cfClientSecret !== undefined &&
    cfClientSecret !== ""
      ? { clientId: cfClientId, clientSecret: cfClientSecret }
      : undefined;

  const subs = new SubscriptionManager(secret, relayUrl);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {},
      instructions: buildInstructions(relayUrl, REGISTERED_TOOLS, cfAccess),
    },
  );

  registerPostMessageTool(server, secret, relayUrl, cfAccess);
  registerEditMessageTool(server, secret, relayUrl, cfAccess);
  registerReactTool(server, secret, relayUrl, cfAccess);
  registerIdentityTool(server, secret, relayUrl, cfAccess);
  registerListChannelsTool(server, secret, relayUrl, cfAccess);
  registerCreateChannelTool(server, secret, relayUrl, cfAccess);
  registerAddMemberTool(server, secret, relayUrl, cfAccess);
  registerFetchEventsTool(server, secret, relayUrl, cfAccess);
  registerSearchTool(server, secret, relayUrl, cfAccess);
  registerCreateJobTool(server, secret, relayUrl, cfAccess);
  registerApproveWorkflowTool(server, secret, relayUrl, cfAccess);
  registerUploadMediaTool(server, secret, relayUrl, cfAccess);
  registerPostThreadSummaryTool(server, secret, relayUrl, cfAccess);
  registerSubscribeTool(server, subs, cfAccess);
  registerUnsubscribeTool(server, subs, cfAccess);
  registerPollTool(server, subs, cfAccess);

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
