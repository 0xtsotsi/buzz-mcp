/**
 * Subscription MCP tools: `buzz_subscribe`, `buzz_unsubscribe`, `buzz_poll`.
 *
 * All three tools share the same {@link SubscriptionManager} instance held in
 * the McpServer's closure. The manager lazily opens a single NIP-01 WS to
 * the relay on first use, completes the NIP-42 `AUTH` handshake if the
 * relay sends a challenge, and buffers `EVENT` frames per-sub.
 *
 * Each tool races its inner promise against a 5-second timeout so the stdio
 * transport can never block indefinitely on a stuck WS.
 *
 * Errors thrown by `execute` are converted to MCP tool results by the SDK —
 * they never crash the transport.
 */
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  SubscriptionManager,
  type SubscriptionEvent,
  type SubscriptionFilter,
} from "../relay/subscription.js";

/** Per-call timeout, milliseconds. The relay should ack in <2s; 5s is generous. */
const TOOL_TIMEOUT_MS = 5_000;

/** sub_id values are 32-char lowercase hex (crypto.randomUUID() stripped of dashes). */
const SUB_ID_REGEX = /^[0-9a-f]{32}$/;

/** Default and hard cap for the relay-side `limit`. */
const SUBSCRIBE_DEFAULT_LIMIT = 100;
const SUBSCRIBE_MAX_LIMIT = 1_000;

/** Default and hard cap for the per-call drain size. */
const POLL_DEFAULT_MAX = 50;
const POLL_MAX_MAX = 500;

// ─── schemas ───────────────────────────────────────────────────────────────

const subscribeFilterSchema = z
  .object({
    kinds: z
      .array(z.number().int().min(0).max(65535))
      .optional()
      .describe("Filter by event kind (NIP-01)."),
    authors: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .optional()
      .describe("Filter by author pubkey (hex)."),
    "#e": z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .optional()
      .describe("Filter by `#e` tag (referenced event id)."),
    "#t": z
      .array(z.string().min(1).max(64))
      .optional()
      .describe("Filter by `#t` tag (hashtag / subject)."),
    since: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Lower bound on `created_at` (unix seconds)."),
    until: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Upper bound on `created_at` (unix seconds)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(SUBSCRIBE_MAX_LIMIT)
      .optional()
      .describe(
        `Result limit (default ${SUBSCRIBE_DEFAULT_LIMIT}, max ${SUBSCRIBE_MAX_LIMIT}).`,
      ),
    search: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Free-text search (NIP-50, relay-side if supported)."),
  })
  .passthrough();

const subscribeArgsSchema = z.object({
  kinds: z
    .array(z.number().int().min(0).max(65535))
    .optional()
    .describe("Shortcut: filter by kind. Defaults to [1] when no filter is given."),
  authors: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .optional()
    .describe("Shortcut: filter by author pubkey (hex)."),
  "#e": z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .optional()
    .describe("Shortcut: filter by `#e` tag."),
  "#t": z
    .array(z.string().min(1).max(64))
    .optional()
    .describe("Shortcut: filter by `#t` tag."),
  since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(SUBSCRIBE_MAX_LIMIT)
    .optional()
    .describe(
      `Default ${SUBSCRIBE_DEFAULT_LIMIT}, max ${SUBSCRIBE_MAX_LIMIT}.`,
    ),
  search: z.string().min(1).max(256).optional(),
  filter: subscribeFilterSchema.optional().describe(
    "Optional raw NIP-01 filter. Top-level shortcut fields override matching keys here.",
  ),
});

const unsubscribeArgsSchema = z.object({
  subId: z
    .string()
    .regex(SUB_ID_REGEX, "must be a 32-char lowercase hex sub_id")
    .describe("The sub_id returned by buzz_subscribe. Required."),
});

const pollArgsSchema = z.object({
  subId: z
    .string()
    .regex(SUB_ID_REGEX, "must be a 32-char lowercase hex sub_id")
    .describe("The sub_id to drain. Required."),
  max: z
    .number()
    .int()
    .positive()
    .max(POLL_MAX_MAX)
    .optional()
    .describe(
      `Max events to drain (default ${POLL_DEFAULT_MAX}, max ${POLL_MAX_MAX}).`,
    ),
});

// ─── timeout helper ────────────────────────────────────────────────────────

/**
 * Race a promise against a timer. Used to enforce the per-tool 5s ceiling
 * without touching the underlying WS — `SubscriptionManager.start()` can
 * block on a TCP/TLS handshake, and we want the tool to surface a timeout
 * rather than hang forever.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}: timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// ─── public tool registrations ─────────────────────────────────────────────

/**
 * Build the wire-level filter handed to the relay. Top-level shortcut fields
 * (kinds / authors / #e / #t / since / until / limit / search) win over
 * matching keys inside `args.filter`. If the result would be an empty
 * filter object we fall back to `{ kinds: [1] }` so the relay has a sensible
 * default (kind:1 text notes).
 */
function buildFilter(args: z.infer<typeof subscribeArgsSchema>): SubscriptionFilter {
  const fromFilter = (args.filter ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...fromFilter };
  for (const key of [
    "kinds",
    "authors",
    "since",
    "until",
    "limit",
    "search",
  ] as const) {
    const v = args[key];
    if (v !== undefined) merged[key] = v;
  }
  if (args["#e"] !== undefined) merged["#e"] = args["#e"];
  if (args["#t"] !== undefined) merged["#t"] = args["#t"];
  if (Object.keys(merged).length === 0) {
    merged.kinds = [1];
  }
  if (merged.limit === undefined) {
    merged.limit = SUBSCRIBE_DEFAULT_LIMIT;
  }
  return merged as SubscriptionFilter;
}

/**
 * JSON tool result envelope used by every tool in this file.
 */
function textResult(value: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * Register `buzz_subscribe`. Opens a `["REQ", sub_id, filter]` against the
 * shared `SubscriptionManager`. Returns `{sub_id, open, filter}` on success.
 *
 * The lazy `SubscriptionManager.start()` call inside `subscribe()` may block
 * on the initial WS open + NIP-42 auth; the 5s timeout catches the worst
 * case (relay is unreachable) and surfaces it as a tool error.
 */
export function registerSubscribeTool(
  server: McpServer,
  subs: SubscriptionManager,
): void {
  server.tool(
    "buzz_subscribe",
    "Open a subscription on the relay's WebSocket. Returns a `sub_id` you " +
      "pass to buzz_poll and buzz_unsubscribe. Events are buffered per " +
      "sub_id (not streamed) — call buzz_poll to drain them. The default " +
      "filter is {kinds: [1]} when no fields are provided.",
    subscribeArgsSchema.shape,
    async (args) => {
      const filter = buildFilter(args);
      const sub_id = await withTimeout(
        subs.subscribe(filter),
        TOOL_TIMEOUT_MS,
        "buzz_subscribe",
      );
      return textResult({ sub_id, open: true, filter });
    },
  );
}

/**
 * Register `buzz_unsubscribe`. Sends `["CLOSE", subId]` and removes the sub
 * from the manager. No-op for an unknown sub_id (returns `closed: false`).
 */
export function registerUnsubscribeTool(
  server: McpServer,
  subs: SubscriptionManager,
): void {
  server.tool(
    "buzz_unsubscribe",
    "Close a subscription opened by buzz_subscribe. Sends [" +
      '"CLOSE", subId] to the relay and drops the sub from the manager\'s ' +
      "in-memory map. No-op on an unknown sub_id.",
    unsubscribeArgsSchema.shape,
    async (args) => {
      const before = subs.listSubs().includes(args.subId);
      await withTimeout(
        subs.unsubscribe(args.subId),
        TOOL_TIMEOUT_MS,
        "buzz_unsubscribe",
      );
      return textResult({ sub_id: args.subId, closed: before });
    },
  );
}

/**
 * Register `buzz_poll`. Drains up to `max` events from the named sub's FIFO
 * buffer in declaration order. Returns `{sub_id, events, remaining}`.
 */
export function registerPollTool(
  server: McpServer,
  subs: SubscriptionManager,
): void {
  server.tool(
    "buzz_poll",
    "Drain buffered events from a subscription. Returns up to `max` events " +
      "(default 50, max 500) in FIFO order plus `remaining`, the number of " +
      "events still buffered after the drain. An unknown sub_id returns " +
      "events: [].",
    pollArgsSchema.shape,
    async (args) => {
      const max = args.max ?? POLL_DEFAULT_MAX;
      const events: SubscriptionEvent[] = subs.poll(args.subId, max);
      const remaining = subs.remaining(args.subId);
      return textResult({ sub_id: args.subId, events, remaining });
    },
  );
}
