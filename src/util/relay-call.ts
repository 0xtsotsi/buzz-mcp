/**
 * Shared helpers for the @buzz/mcp tool layer.
 *
 * Every tool that talks to a CorePrt relay uses the same three things:
 *   1. A 5-second timeout enforced at the wire (not just at the call site).
 *   2. A way to parse the relay's `{ok,id}` / `{event_id,accepted}` ack into
 *      a normalized shape.
 *   3. A consistent error envelope.
 *
 * This module centralizes those. Adding a new tool should not require
 * re-implementing the timeout/ack/error dance.
 */
import { signedFetch, type SignedFetchOptions } from "../relay/client.js";

/** Default per-tool timeout, in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 5_000;

/**
 * Race a signedFetch against a timeout. The fetch's underlying request is
 * aborted when the timer fires (or when the caller passes in their own
 * `signal` and that one fires).
 *
 * The relay's `_liveness` / `_readiness` endpoints respond in <50ms, so a
 * 5s ceiling is generous. A genuine 5s response almost always means
 * something is wrong upstream; surfacing the timeout as an error is more
 * useful than letting the tool hang.
 */
export async function signedFetchWithTimeout(
  secret: Parameters<typeof signedFetch>[0],
  opts: SignedFetchOptions,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<Awaited<ReturnType<typeof signedFetch>>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // If the caller already passed a signal, forward its abort.
  if (opts.signal) {
    if (opts.signal.aborted) {
      ac.abort();
    } else {
      opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
  }
  try {
    return await signedFetch(secret, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the relay-assigned event id from a `/events` POST ack body.
 *
 * Two shapes are seen in the wild:
 *   { "ok": true, "id": "<64-hex>" }
 *   { "event_id": "<64-hex>", "accepted": true }
 *
 * Both are normalized to a 64-char lowercase hex string, or null if the
 * body does not have a recognizable id.
 */
export function parseAckId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const key of ["id", "event_id"] as const) {
    const v = obj[key];
    if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) {
      return v;
    }
  }
  return null;
}

/**
 * Build a consistent error string for inclusion in an MCP tool's thrown
 * Error. Format: `relay(<url>): HTTP <status> — <body>` or
 *               `relay(<url>): network — <message>`.
 */
export function formatRelayError(
  relayUrl: string,
  detail: { status?: number; bodyText?: string } | { cause: Error },
): string {
  if ("status" in detail && detail.status !== undefined) {
    return `relay(${relayUrl}): HTTP ${detail.status} — ${(detail.bodyText ?? "").slice(0, 500)}`;
  }
  // After narrowing on 'status', the other branch is `{ cause: Error }`.
  const network = detail as { cause: Error };
  return `relay(${relayUrl}): network — ${network.cause.message}`;
}
