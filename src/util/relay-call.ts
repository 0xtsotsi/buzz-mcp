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
 *
 * Phase 2 (multi-relay plan) adds:
 *   - Structured logging on every signed fetch (info / warn / debug).
 *   - Stats recording on every signed fetch (Phase 2 exposes them via
 *     `buzz_get_stats`; Phase 3's `RelayPool` will pass a shared store).
 */
import { type SignedFetchOptions, signedFetch } from "../relay/client.js";
import { outcomeFromStatus, type StatsStore } from "../relay/stats.js";
import { getLogger } from "./log.js";

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
 *
 * If `cfAccess` is provided, `CF-Access-Client-Id` and `CF-Access-Client-Secret`
 * are merged into the request headers (alongside the NIP-98 `Authorization`
 * that `signedFetch` always sets). Explicit `opts.headers` win over `cfAccess`.
 * Cloudflare Access sits in front of the relay at `https://coreprt.webrnds.com`,
 * so production deploys must pass these or every request 401's before the
 * NIP-98 layer is reached. The credentials are read once at startup and
 * never appear in tool-result payloads or logs.
 */
/**
 * Cloudflare Access service-token credentials. Forwarded as the
 * `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers on every
 * signedFetch call when present. See `signedFetchWithTimeout` for full
 * details. The secret value itself never appears in tool-result payloads
 * or logs.
 */
export type CfAccess = { clientId: string; clientSecret: string };

/**
 * Phase 2: optional `stats` sink. When provided, every signed fetch
 * records its outcome into the `StatsStore` so `buzz_get_stats` can
 * surface it. Phase 3's `RelayPool` will pass a single shared store.
 */
export interface SignedFetchWithTimeoutExtras {
  stats?: StatsStore;
  /** Tool name to log with. Default `undefined`. */
  tool?: string;
}

export async function signedFetchWithTimeout(
  secret: import("../relay/signer.js").NsecOrHex,
  opts: SignedFetchOptions,
  timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS,
  cfAccess?: CfAccess,
  extras: SignedFetchWithTimeoutExtras = {},
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
  const log = getLogger();
  const start = Date.now();
  try {
    const mergedOpts: SignedFetchOptions =
      cfAccess !== undefined
        ? {
            ...opts,
            headers: {
              ...opts.headers,
              "CF-Access-Client-Id": cfAccess.clientId,
              "CF-Access-Client-Secret": cfAccess.clientSecret,
            },
          }
        : opts;
    const result = await signedFetch(secret, { ...mergedOpts, signal: ac.signal });
    const latencyMs = Date.now() - start;
    const outcome = outcomeFromStatus(result.status);
    if (extras.stats !== undefined) {
      extras.stats.record(opts.url, outcome, latencyMs);
    }
    log.debug("relay.fetch", {
      tool: extras.tool,
      url: opts.url,
      status: result.status,
      latency_ms: latencyMs,
      outcome,
    });
    return result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = (err as Error).name === "AbortError";
    if (extras.stats !== undefined) {
      extras.stats.record(opts.url, isTimeout ? "timeout" : "network_error", latencyMs);
    }
    log.warn("relay.fetch.error", {
      tool: extras.tool,
      url: opts.url,
      latency_ms: latencyMs,
      outcome: isTimeout ? "timeout" : "network_error",
      error: (err as Error).message,
    });
    throw err;
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
