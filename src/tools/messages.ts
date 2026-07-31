/**
 * Message MCP tools: `buzz_post_message`, `buzz_edit_message`, `buzz_react`.
 *
 * Each posts a signed Nostr event (kind:9 stream message, kind:40003 edit,
 * or kind:7 reaction) to a CorePrt relay. The relay URL and the operator's
 * Nostr secret come from environment variables — never from tool parameters.
 *
 * Environment (read once at createServer() time):
 *   BUZZ_RELAY_URL    — e.g. "https://coreprt.webrnds.com" or
 *                       "http://127.0.0.1:3030" for the local harness.
 *   BUZZ_PRIVATE_KEY  — the agent's nsec1… or 64-char hex secret.
 *
 * Errors thrown by `execute` are converted to MCP tool results by the SDK
 * — they never crash the stdio transport.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { signedFetch } from "../relay/client.js";
import { type NsecOrHex } from "../relay/signer.js";
import { type ImetaEntry, buildEdit, buildMessage, buildReaction } from "../relay/event-builder.js";

/** Hard cap on a single message body, in bytes (UTF-8). */
const MAX_CONTENT_BYTES = 32 * 1024;

/** Hard cap on the number of media entries per message. */
const MAX_IMETA_ENTRIES = 16;

/** Per-call timeout. The relay should ack in <1s; 5s is generous. */
const TOOL_TIMEOUT_MS = 5_000;

/** Extract the relay-assigned event id from a relay ack body. */
function extractEventId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.id === "string" && /^[0-9a-f]{64}$/.test(obj.id)) {
    return obj.id;
  }
  if (typeof obj.event_id === "string" && /^[0-9a-f]{64}$/.test(obj.event_id)) {
    return obj.event_id;
  }
  return null;
}

/**
 * Register `buzz_post_message` on the given server. The `secret` is captured
 * in the closure so the tool never touches the environment at call time.
 *
 * The server registers exactly one tool. PR #4 adds the rest.
 */
export function registerPostMessageTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  // Note: AbortController-based timeout is wired around the signedFetch call
  // below; signedFetch itself does not accept a signal, so we race it.
  server.tool(
    "buzz_post_message",
    "Post a message to a CorePrt channel. Returns {event_id, accepted, channel} on success. " +
      "The relay may take 1-2s to acknowledge. The BUZZ_PRIVATE_KEY env var must be set; " +
      "never pass the key as a parameter. Imeta entries follow NIP-92; replyTo is a 64-char hex event id.",
    {
      channel: z
        .string()
        .min(1)
        .max(64)
        .describe("Channel name. Leading '#' is stripped. Required."),
      content: z
        .string()
        .min(1)
        .describe("Message body, UTF-8. Required. Hard cap 32KB."),
      replyTo: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe("64-char hex event id being replied to (NIP-10)."),
      imeta: z
        .array(
          z.object({
            url: z.string().url(),
            mime: z.string().optional(),
            sha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            blurhash: z.string().optional(),
          }),
        )
        .max(MAX_IMETA_ENTRIES)
        .optional()
        .describe("NIP-92 media entries, max 16."),
    },
    async (args) => {
      // 1. Byte-length guard (the relay's max_plaintext_len is 32768).
      const bytes = new TextEncoder().encode(args.content).byteLength;
      if (bytes > MAX_CONTENT_BYTES) {
        throw new Error(
          `content is ${bytes} bytes, exceeds ${MAX_CONTENT_BYTES}-byte cap`,
        );
      }

      // 2. Build the event (signs locally with the captured secret).
      const event = await buildMessage({
        secret,
        channel: args.channel,
        content: args.content,
        replyTo: args.replyTo,
        imeta: args.imeta as ImetaEntry[] | undefined,
      });

      // 3. POST to the relay with a 5s timeout (race the signedFetch).
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
      let resp;
      try {
        resp = await Promise.race([
          signedFetch(secret, {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/events`,
            body: JSON.stringify(event),
            headers: { "content-type": "application/json" },
          }),
          new Promise<never>((_, reject) => {
            ac.signal.addEventListener("abort", () =>
              reject(new Error(`aborted after ${TOOL_TIMEOUT_MS}ms`)),
            );
          }),
        ]);
      } catch (err) {
        clearTimeout(timer);
        throw new Error(
          `relay at ${relayUrl} did not respond: ${(err as Error).message}`,
        );
      }
      clearTimeout(timer);

      // 4. Parse + extract. 2xx = accepted.
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected event: HTTP ${resp.status} — ${resp.bodyText.slice(0, 500)}`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(resp.bodyText);
      } catch {
        parsed = null;
      }
      const eventId = extractEventId(parsed);
      const channelName = args.channel.replace(/^#/, "").trim();

      if (eventId !== null) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { event_id: eventId, accepted: true, channel: channelName },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Relay returned 2xx but no recognizable id — surface the raw body.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                accepted: true,
                channel: channelName,
                raw: parsed ?? resp.bodyText.slice(0, 1000),
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
 * Register `buzz_edit_message`. Builds a kind:40003 edit event with
 * `["e", originalEventId, "", "edit"]` and posts to `/events`.
 *
 * NOTE: kind:40003 is the *relay-owner* edit kind per the Rust SDK comment in
 * `buildEdit` (`src/relay/event-builder.ts`). In practice only the relay owner
 * can publish 40003 because the relay re-signs with its own key. For a
 * member-agent, edits may need to be kind:5 (NIP-33) — for this PR we wire up
 * 40003 as-is and document the assumption. If a future run shows the relay
 * rejects member-signed 40003, switch to kind:5 in a follow-up.
 */
export function registerEditMessageTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  server.tool(
    "buzz_edit_message",
    "Edit an existing message (kind:40003). Returns the event id, the " +
      "target event id, and the new content. NOTE: 40003 is the relay-owner " +
      "edit kind — see the buildEdit helper for caveats.",
    {
      eventId: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
        .describe("Event id of the message being edited. Required."),
      content: z
        .string()
        .min(1)
        .max(MAX_CONTENT_BYTES)
        .describe("New content body. Required. Hard cap 32 KB."),
      originalKind: z
        .union([z.literal(1), z.literal(9)])
        .describe("Kind of the event being edited (1 or 9). Required."),
    },
    async (args) => {
      const byteLen = new TextEncoder().encode(args.content).byteLength;
      if (byteLen > MAX_CONTENT_BYTES) {
        throw new Error(
          `content is ${byteLen} bytes, exceeds ${MAX_CONTENT_BYTES}-byte cap`,
        );
      }

      const event = await buildEdit({
        secret,
        originalEventId: args.eventId,
        newContent: args.content,
        originalKind: args.originalKind,
      });

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
      let resp;
      try {
        resp = await Promise.race([
          signedFetch(secret, {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/events`,
            body: JSON.stringify(event),
            headers: { "content-type": "application/json" },
          }),
          new Promise<never>((_, reject) => {
            ac.signal.addEventListener("abort", () =>
              reject(new Error(`aborted after ${TOOL_TIMEOUT_MS}ms`)),
            );
          }),
        ]);
      } catch (err) {
        clearTimeout(timer);
        throw new Error(
          `relay at ${relayUrl} did not respond: ${(err as Error).message}`,
        );
      }
      clearTimeout(timer);

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected event: HTTP ${resp.status} — ${resp.bodyText.slice(0, 500)}`,
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
                target: args.eventId,
                new_content: args.content,
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
 * Register `buzz_react`. Builds a kind:7 NIP-25 reaction event and posts to
 * `/events`. The emoji is held both as the event `content` and in the
 * `["content", emoji]` tag for legacy compatibility.
 */
export function registerReactTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  server.tool(
    "buzz_react",
    "Post a reaction (kind:7 NIP-25). Returns the event id, the target event " +
      "id, and the emoji.",
    {
      eventId: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
        .describe("Event id of the message being reacted to. Required."),
      emoji: z
        .string()
        .min(1)
        .max(16)
        .describe("Emoji shortcode (1–16 chars). Required."),
    },
    async (args) => {
      const event = await buildReaction({
        secret,
        targetEventId: args.eventId,
        emoji: args.emoji,
      });

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
      let resp;
      try {
        resp = await Promise.race([
          signedFetch(secret, {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/events`,
            body: JSON.stringify(event),
            headers: { "content-type": "application/json" },
          }),
          new Promise<never>((_, reject) => {
            ac.signal.addEventListener("abort", () =>
              reject(new Error(`aborted after ${TOOL_TIMEOUT_MS}ms`)),
            );
          }),
        ]);
      } catch (err) {
        clearTimeout(timer);
        throw new Error(
          `relay at ${relayUrl} did not respond: ${(err as Error).message}`,
        );
      }
      clearTimeout(timer);

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected event: HTTP ${resp.status} — ${resp.bodyText.slice(0, 500)}`,
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
                target: args.eventId,
                emoji: args.emoji,
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
