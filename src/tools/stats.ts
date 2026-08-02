/**
 * `buzz_get_stats` — return the per-relay stats snapshot.
 *
 * Phase 2 of the multi-relay plan. The tool exposes the in-memory
 * `StatsStore` that the relay client writes to. The snapshot is a
 * frozen array of `RelayStats` — one record per relay URL that has
 * been called at least once.
 *
 * The tool is read-only and never blocked by mode or by the
 * `mutate-with-confirm` gate.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StatsStore } from "../relay/stats.js";

export function registerGetStatsTool(server: McpServer, store: StatsStore): void {
  server.tool(
    "buzz_get_stats",
    "Return the per-relay stats snapshot. One record per relay URL that has been " +
      "called at least once. Fields: calls_total, success, rejected_400..403, " +
      "timeout, network_error, latency_p50_ms, latency_p95_ms, last_success_at, " +
      "last_error_at. Read-only — never gated by BUZZ_MCP_MODE.",
    {
      relay: z
        .string()
        .url()
        .optional()
        .describe(
          "If set, return the stats for only this relay. Otherwise return all known relays.",
        ),
    },
    async (args) => {
      const relay = args.relay;
      const snapshot =
        relay === undefined
          ? store.snapshot()
          : (() => {
              const one = store.forRelay(relay);
              return one === null ? [] : [one];
            })();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                stats: snapshot,
                snapshot_at: new Date().toISOString(),
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
