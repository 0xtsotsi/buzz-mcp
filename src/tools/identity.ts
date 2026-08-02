/**
 * Identity & channel MCP tools.
 *
 * Hosts four tools: `buzz_identity`, `buzz_list_channels`,
 * `buzz_create_channel`, `buzz_add_member`. They share the same Zod schema +
 * signedFetch shape as `buzz_post_message` from PR #3.
 *
 * Read tools use plain `fetch` with a 5s timeout (no NIP-98 — NIP-11 is
 * intentionally unauthenticated). Write tools use `signedFetch` exactly like
 * the first-tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { npubEncode } from "nostr-tools/nip19";
import { z } from "zod";
import type { BuzzConfig } from "../config/schema.js";
import type { SignedFetchResult } from "../relay/client.js";
import { buildAddMember, buildCreateChannel } from "../relay/event-builder.js";
import { getPublicKey, type NostrEvent, type NsecOrHex } from "../relay/signer.js";
import { gateToMcpBody, gateWrite } from "../util/mode.js";
import type { SignedFetchWithTimeoutExtras } from "../util/relay-call.js";
import { type CfAccess, formatRelayError, signedFetchWithTimeout } from "../util/relay-call.js";

const RELAY_BODY_PRINT_LIMIT = 1_000;

/** Per-call timeout (default). 5s is generous; the relay acks in <1s. */
const TOOL_TIMEOUT_MS = 5_000;

/**
 * Probe the relay for NIP-11 info. Tries `/api/identity` first, then `/info`,
 * returning the first 2xx body. Returns `null` if every probe fails.
 */
async function probeRelayInfo(
  relayUrl: string,
): Promise<{ status: number; body: unknown; path: string } | null> {
  const base = relayUrl.replace(/\/$/, "");
  for (const path of ["/api/identity", "/info"]) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
      if (res.status >= 200 && res.status < 300) {
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep as text */
        }
        return { status: res.status, body: parsed, path };
      }
    } catch {
      /* swallow and try next */
    }
  }
  return null;
}

/**
 * Register `buzz_identity`. No inputs. Returns the relay's NIP-11 info doc
 * (probed) plus the operator pubkey + npub derived from `BUZZ_PRIVATE_KEY`.
 */
export function registerIdentityTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
  _cfAccess?: CfAccess,
): void {
  server.tool(
    "buzz_identity",
    "Return the relay's NIP-11 info document and the operator's Nostr pubkey. " +
      "Probes /api/identity then /info. No inputs required.",
    {},
    async () => {
      const operatorHex = getPublicKey(secret);
      const operatorNpub = npubEncode(operatorHex);

      const probe = await probeRelayInfo(relayUrl);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                relay: probe?.body ?? null,
                relay_path_used: probe?.path ?? null,
                relay_status: probe?.status ?? null,
                operator: { pubkey: operatorHex, npub: operatorNpub },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/**
 * Register `buzz_list_channels`. No inputs. Queries `/query` for the
 * operator's kind:9007 (NIP-29 `create_channel`) events and returns them with
 * a derived `name` from `["name"]` (canonical NIP-29) or `["subject"]`
 * (legacy alias used in PR #3 messages).
 */
export function registerListChannelsTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
  cfAccess?: CfAccess,
): void {
  server.tool(
    "buzz_list_channels",
    "List channels visible to the operator (kind:9007 create_channel events). " +
      "Returns the raw events plus a derived `name` and `visibility`. No inputs.",
    {},
    async () => {
      const operatorHex = getPublicKey(secret);
      // NIP-01: filters is an array of filter objects. Wrap the single filter
      // so the relay's strict deserializer sees a sequence, not a map.
      const body = JSON.stringify([
        {
          kinds: [9007],
          authors: [operatorHex],
          limit: 100,
        },
      ]);

      let resp: SignedFetchResult;
      try {
        resp = await signedFetchWithTimeout(
          secret,
          {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/query`,
            body,
            headers: { "content-type": "application/json" },
          },
          TOOL_TIMEOUT_MS,
          cfAccess,
        );
      } catch (err) {
        throw new Error(formatRelayError(relayUrl, { cause: err as Error }));
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          formatRelayError(relayUrl, {
            status: resp.status,
            bodyText: resp.bodyText,
          }),
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(resp.bodyText);
      } catch {
        throw new Error(
          `relay returned non-JSON body for /query: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      let events: NostrEvent[];
      if (Array.isArray(parsed)) {
        events = parsed as NostrEvent[];
      } else {
        const obj = parsed as { events?: unknown };
        if (obj && Array.isArray(obj.events)) {
          events = obj.events as NostrEvent[];
        } else {
          throw new Error(
            `relay /query did not return an event array: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
          );
        }
      }

      const channels = events.map((evt) => {
        const nameTag = evt.tags.find((t) => t[0] === "name");
        const subjectTag = evt.tags.find((t) => t[0] === "subject");
        const visibilityTag = evt.tags.find((t) => t[0] === "visibility");
        return {
          id: evt.id,
          created_at: evt.created_at,
          name: nameTag?.[1] ?? subjectTag?.[1] ?? null,
          visibility: visibilityTag?.[1] ?? null,
          raw: evt,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ channels }, null, 2),
          },
        ],
      };
    },
  );
}

/**
 * Register `buzz_create_channel`. POSTs a kind:9007 NIP-29 `create_channel`
 * event to `/events`. The relay allocates the channel UUID.
 *
 * Phase 1 (multi-relay plan): respects `BUZZ_MCP_MODE` and `dryRun`.
 *   - `BUZZ_MCP_MODE=read-only`            → throws at dispatch.
 *   - `BUZZ_MCP_MODE=mutate-with-confirm` → returns
 *     `{status: 'pending-confirm', unsigned_event}` unless `confirm: true`.
 *   - `dryRun: true`                      → returns the signed event JSON
 *     without posting.
 */
export function registerCreateChannelTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
  cfAccess?: CfAccess,
  config?: BuzzConfig,
  extras?: SignedFetchWithTimeoutExtras,
): void {
  server.tool(
    "buzz_create_channel",
    "Create a new channel (kind:9007 NIP-29 create_channel). Returns the event id " +
      "and the channel name/visibility. The relay allocates the channel UUID. " +
      "Respects BUZZ_MCP_MODE (read-only / mutate-with-confirm / mutate) and " +
      "accepts dryRun: true to inspect the signed event without posting.",
    {
      name: z.string().min(1).max(64).describe("Channel name (NIP-29). Required."),
      visibility: z
        .enum(["public", "private"])
        .optional()
        .describe('Channel visibility (default "public").'),
      description: z
        .string()
        .max(2048)
        .optional()
        .describe("Optional human-readable channel description (NIP-29 `about` tag)."),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          "If true, return the signed event JSON without posting. Useful for previews. " +
            "Useful for previews; ignored in mutate-with-confirm mode (the " +
            "pending-confirm response already exposes the unsigned event).",
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Required when BUZZ_MCP_MODE=mutate-with-confirm. Re-call with " +
            "confirm: true to actually publish the pending event.",
        ),
    },
    async (args) => {
      const event = await buildCreateChannel({
        secret,
        name: args.name,
        visibility: args.visibility,
        description: args.description,
      });

      const gate = gateWrite({
        mode: config?.mode ?? "mutate",
        confirm: args.confirm,
        dryRun: args.dryRun,
        unsigned: event,
        preview: `create_channel name=${args.name} visibility=${args.visibility ?? "public"}`,
      });

      if (gate.kind === "read-only") {
        throw new Error(gate.message);
      }
      if (gate.kind === "pending-confirm" || gate.kind === "dry-run") {
        return {
          content: [
            {
              type: "text" as const,
              text: gateToMcpBody(gate, {
                channel: { name: args.name, visibility: args.visibility ?? "public" },
              }),
            },
          ],
        };
      }

      let resp: SignedFetchResult;
      try {
        resp = await signedFetchWithTimeout(
          secret,
          {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/events`,
            body: JSON.stringify(event),
            headers: { "content-type": "application/json" },
          },
          TOOL_TIMEOUT_MS,
          cfAccess,
          { stats: extras?.stats, tool: "buzz_create_channel" },
        );
      } catch (err) {
        throw new Error(formatRelayError(relayUrl, { cause: err as Error }));
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          formatRelayError(relayUrl, {
            status: resp.status,
            bodyText: resp.bodyText,
          }),
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                event_id: event.id,
                accepted: true,
                channel: {
                  name: args.name,
                  visibility: args.visibility ?? "public",
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/**
 * Register `buzz_add_member`. POSTs a kind:9000 NIP-29 `add_member` event to
 * `/events`.
 *
 * NOTE (CLAUDE.md / `CorePrt/run.sh:120`): real back-to-back add_member calls
 * must be `sleep 1` apart to let the relay settle the kind:9000 → 44100
 * notification round-trip. The tool description mentions this; the
 * implementation does NOT enforce the sleep — that's the caller's job.
 */
export function registerAddMemberTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
  cfAccess?: CfAccess,
  config?: BuzzConfig,
  extras?: SignedFetchWithTimeoutExtras,
): void {
  server.tool(
    "buzz_add_member",
    "Add a member to a channel (kind:9000 NIP-29 add_member). " +
      "IMPORTANT: real back-to-back add_member calls must be `sleep 1` apart " +
      "to let the relay settle the kind:9000 → 44100 notification round-trip; " +
      "this tool does NOT enforce that — the caller is responsible. " +
      "Respects BUZZ_MCP_MODE and accepts dryRun: true (returns the signed event without posting).",
    {
      pubkey: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
        .describe("Pubkey (hex) of the member to add. Required."),
      role: z.enum(["admin", "member"]).optional().describe('Member role (default "member").'),
      dryRun: z
        .boolean()
        .optional()
        .describe("If true, return the signed event JSON without posting. Useful for previews."),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Required when BUZZ_MCP_MODE=mutate-with-confirm. Re-call with " +
            "confirm: true to actually publish the pending event.",
        ),
    },
    async (args) => {
      const event = await buildAddMember({
        secret,
        pubkey: args.pubkey,
        role: args.role,
      });

      const gate = gateWrite({
        mode: config?.mode ?? "mutate",
        confirm: args.confirm,
        dryRun: args.dryRun,
        unsigned: event,
        preview: `add_member pubkey=${args.pubkey} role=${args.role ?? "member"}`,
      });

      if (gate.kind === "read-only") {
        throw new Error(gate.message);
      }
      if (gate.kind === "pending-confirm" || gate.kind === "dry-run") {
        return {
          content: [
            {
              type: "text" as const,
              text: gateToMcpBody(gate, {
                member: { pubkey: args.pubkey, role: args.role ?? "member" },
              }),
            },
          ],
        };
      }

      let resp: SignedFetchResult;
      try {
        resp = await signedFetchWithTimeout(
          secret,
          {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/events`,
            body: JSON.stringify(event),
            headers: { "content-type": "application/json" },
          },
          TOOL_TIMEOUT_MS,
          cfAccess,
          { stats: extras?.stats, tool: "buzz_add_member" },
        );
      } catch (err) {
        throw new Error(formatRelayError(relayUrl, { cause: err as Error }));
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          formatRelayError(relayUrl, {
            status: resp.status,
            bodyText: resp.bodyText,
          }),
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                event_id: event.id,
                accepted: true,
                member: { pubkey: args.pubkey, role: args.role ?? "member" },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
