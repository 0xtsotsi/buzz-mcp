/**
 * Thread-summary MCP tool.
 *
 * `buzz_post_thread_summary` posts a kind:39005 `KIND_THREAD_SUMMARY` event
 * (`CorePrt-relay/crates/buzz-core/src/kind.rs:375`) referencing the
 * thread's root event with a NIP-10 `["e", root, "", "root"]` tag.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SignedFetchResult } from "../relay/client.js";
import { signedFetch } from "../relay/client.js";
import { buildThreadSummary } from "../relay/event-builder.js";
import type { NsecOrHex } from "../relay/signer.js";
import type { CfAccess } from "../util/relay-call.js";

const RELAY_BODY_PRINT_LIMIT = 1_000;
const TOOL_TIMEOUT_MS = 5_000;
const MAX_SUMMARY_BYTES = 32 * 1024;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () =>
          reject(new Error(`${label}: aborted after ${ms}ms`)),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register `buzz_post_thread_summary`. POSTs a kind:39005 event with
 * `["e", rootEventId, "", "root"]` and the summary text in `content`.
 */
export function registerPostThreadSummaryTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
  cfAccess?: CfAccess,
): void {
  server.tool(
    "buzz_post_thread_summary",
    "Post a summary for a thread (kind:39005 KIND_THREAD_SUMMARY). " +
      "References the thread's root event with a NIP-10 root tag and carries " +
      "the summary text in `content`.",
    {
      rootEventId: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
        .describe("Root event id of the thread to summarise. Required."),
      summary: z
        .string()
        .min(1)
        .max(MAX_SUMMARY_BYTES)
        .describe(`Summary text. Required. Hard cap ${MAX_SUMMARY_BYTES} bytes (32 KB).`),
    },
    async (args) => {
      const byteLen = new TextEncoder().encode(args.summary).byteLength;
      if (byteLen > MAX_SUMMARY_BYTES) {
        throw new Error(`summary is ${byteLen} bytes, exceeds ${MAX_SUMMARY_BYTES}-byte cap`);
      }

      const event = await buildThreadSummary({
        secret,
        rootEventId: args.rootEventId,
        summary: args.summary,
      });

      let resp: SignedFetchResult;
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (cfAccess !== undefined) {
          headers["CF-Access-Client-Id"] = cfAccess.clientId;
          headers["CF-Access-Client-Secret"] = cfAccess.clientSecret;
        }
        resp = await withTimeout(
          signedFetch(secret, {
            method: "POST",
            url: `${relayUrl.replace(/\/$/, "")}/events`,
            body: JSON.stringify(event),
            headers,
          }),
          TOOL_TIMEOUT_MS,
          "post thread summary",
        );
      } catch (err) {
        throw new Error(`relay at ${relayUrl} did not respond: ${(err as Error).message}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected event: HTTP ${resp.status} — ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
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
                thread: args.rootEventId,
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
