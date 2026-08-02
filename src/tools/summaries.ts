/**
 * Thread-summary MCP tool.
 *
 * `buzz_post_thread_summary` posts a kind:39005 `KIND_THREAD_SUMMARY` event
 * (`CorePrt-relay/crates/buzz-core/src/kind.rs:375`) referencing the
 * thread's root event with a NIP-10 `["e", root, "", "root"]` tag.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildThreadSummary } from "../relay/event-builder.js";
import type { RelayPool } from "../relay/pool.js";
import type { NsecOrHex } from "../relay/signer.js";
import type { CfAccess, SignedFetchWithTimeoutExtras } from "../util/relay-call.js";
import { poolWrite, poolWriteToMcpContent } from "./pool-write.js";

const _RELAY_BODY_PRINT_LIMIT = 1_000;
const _TOOL_TIMEOUT_MS = 5_000;
const MAX_SUMMARY_BYTES = 32 * 1024;

async function _withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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
  _relayUrl: string,
  _cfAccess?: CfAccess,
  _extras?: SignedFetchWithTimeoutExtras,
  pool?: RelayPool,
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
      relays: z
        .array(z.string().url())
        .optional()
        .describe(
          "Optional per-call relay list (overrides the pool default). " +
            "Use this to force a write to a specific relay.",
        ),
      allowFanout: z
        .boolean()
        .optional()
        .describe(
          "When true (default), the write is fanned out to all configured relays. " +
            "Set to false to write only to the default relay.",
        ),
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

      const { mcpBody, isError } = await poolWrite(pool, event, {
        mode: "mutate",
        preview: "buzz_post_thread_summary",
        tool: "buzz_post_thread_summary",
        responseExtras: {
          thread: args.rootEventId,
        },
      });
      return poolWriteToMcpContent(mcpBody, isError);
    },
  );
}
