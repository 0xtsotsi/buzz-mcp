/**
 * `buzz_post_message` — the first MCP tool exposed by @buzz/mcp.
 *
 * Posts a signed Nostr event (kind:9 stream message) to a CorePrt relay.
 * The relay URL and the operator's Nostr secret come from environment
 * variables — never from tool parameters.
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
import { type ImetaEntry, buildMessage } from "../relay/event-builder.js";

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
