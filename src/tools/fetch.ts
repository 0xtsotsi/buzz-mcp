/**
 * Fetch & search MCP tools.
 *
 * `buzz_fetch_events` POSTs a NIP-01 filter to `/query`.
 * `buzz_search` is the same shape with a `search` field — the relay's NIP-50
 * search support is best-effort: if the relay 4xx's on `search` we fall back
 * to a plain fetch + client-side `content.includes(search)` filter.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NostrEvent, NsecOrHex } from "../relay/signer.js";
import { signedFetchWithTimeout } from "../util/relay-call.js";

const RELAY_BODY_PRINT_LIMIT = 1_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * A NIP-01 filter — narrow subset that the relay's `/query` understands.
 * Unknown keys are passed through (`.passthrough()`) so the agent can use
 * filter fields the tool author didn't anticipate without a re-register.
 */
const filterSchema = z
  .object({
    kinds: z.array(z.number().int().min(0).max(65535)).optional(),
    authors: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
    "#e": z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
    "#t": z.array(z.string()).optional(),
    since: z.number().int().nonnegative().optional(),
    until: z.number().int().nonnegative().optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`Result limit (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  })
  .passthrough();

/**
 * Parse the relay body as JSON; return `null` on parse failure so the caller
 * can format a tool-specific error message.
 */
function unwrap(resp: { bodyText: string }): unknown {
  try {
    return JSON.parse(resp.bodyText);
  } catch {
    return null;
  }
}

/**
 * Coerce the parsed relay body into an event array. Accepts either a raw
 * array or `{events: […]}` wrapper.
 */
function asEventArray(parsed: unknown): NostrEvent[] | null {
  if (Array.isArray(parsed)) return parsed as NostrEvent[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as { events?: unknown };
    if (Array.isArray(obj.events)) return obj.events as NostrEvent[];
  }
  return null;
}

/**
 * POST a filter to `/query`, return the raw text and status. Throws only on
 * transport / timeout failure; relay 4xx is returned to the caller so the
 * search tool can implement its fallback path.
 */
type QueryResult = { status: number; bodyText: string };

async function postQuery(
  secret: NsecOrHex,
  relayUrl: string,
  filter: Record<string, unknown>,
): Promise<{ status: number; bodyText: string }> {
  const resp = await signedFetchWithTimeout(secret, {
    method: "POST",
    url: `${relayUrl.replace(/\/$/, "")}/query`,
    body: JSON.stringify(filter),
    headers: { "content-type": "application/json" },
  });
  return { status: resp.status, bodyText: resp.bodyText };
}

/**
 * Register `buzz_fetch_events`. POSTs a NIP-01 filter to `/query` and returns
 * the raw event array.
 */
export function registerFetchEventsTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  server.tool(
    "buzz_fetch_events",
    "Fetch events matching a NIP-01 filter. POSTs the filter to /query and " +
      "returns the raw event array. The filter shape mirrors what /query accepts.",
    {
      filter: filterSchema.describe("NIP-01 filter object. `limit` defaults to 50, max 500."),
    },
    async (args) => {
      const filter: Record<string, unknown> = { ...args.filter };
      if (filter.limit === undefined) {
        filter.limit = DEFAULT_LIMIT;
      }

      let resp: QueryResult;
      try {
        resp = await postQuery(secret, relayUrl, filter);
      } catch (err) {
        throw new Error(`relay at ${relayUrl} did not respond: ${(err as Error).message}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected query: HTTP ${resp.status} — ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      const parsed = unwrap(resp);
      if (parsed === null) {
        throw new Error(
          `relay returned non-JSON body for /query: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      const events = asEventArray(parsed);
      if (events === null) {
        throw new Error(
          `relay /query did not return an event array: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ events }, null, 2),
          },
        ],
      };
    },
  );
}

/**
 * Register `buzz_search`. Like `buzz_fetch_events` but accepts a `search`
 * field for NIP-50 relay-side search. If the relay 4xx's on `search`, fall
 * back to fetching without it and filter client-side by `content.includes`.
 */
export function registerSearchTool(server: McpServer, secret: NsecOrHex, relayUrl: string): void {
  server.tool(
    "buzz_search",
    "Search events by free-text query (NIP-50). Tries relay-side search first; " +
      "if the relay 4xx's on the `search` field, falls back to /query and " +
      "filters client-side by `event.content.includes(search)`.",
    {
      search: z.string().min(1).max(256).describe("Free-text search query. Required."),
      filter: filterSchema
        .optional()
        .describe("Optional NIP-01 filter to narrow the search. `limit` defaults to 50, max 500."),
    },
    async (args) => {
      const baseFilter: Record<string, unknown> = { ...(args.filter ?? {}) };
      if (baseFilter.limit === undefined) {
        baseFilter.limit = DEFAULT_LIMIT;
      }

      // First attempt: relay-side NIP-50 search.
      let resp: QueryResult;
      try {
        resp = await postQuery(secret, relayUrl, {
          ...baseFilter,
          search: args.search,
        });
      } catch (err) {
        throw new Error(`relay at ${relayUrl} did not respond: ${(err as Error).message}`);
      }

      let searchMode: "relay" | "client-side" = "relay";
      // Broad fallback: any 4xx. Some relays reject the unknown `search`
      // field with 400, others 415, others 422 — cover the whole client-error
      // range.
      if (resp.status >= 400 && resp.status < 500) {
        // Fallback: drop `search` and filter client-side.
        searchMode = "client-side";
        try {
          resp = await postQuery(secret, relayUrl, baseFilter);
        } catch (err) {
          throw new Error(`relay at ${relayUrl} did not respond: ${(err as Error).message}`);
        }
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected query: HTTP ${resp.status} — ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      const parsed = unwrap(resp);
      if (parsed === null) {
        throw new Error(
          `relay returned non-JSON body for /query: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      let events = asEventArray(parsed);
      if (events === null) {
        throw new Error(
          `relay /query did not return an event array: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      if (searchMode === "client-side") {
        const needle = args.search;
        events = events.filter((e) => typeof e.content === "string" && e.content.includes(needle));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ events, search_mode: searchMode }, null, 2),
          },
        ],
      };
    },
  );
}
