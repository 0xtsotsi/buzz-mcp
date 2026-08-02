/**
 * Shared helpers for write tools that fan out across the `RelayPool`.
 *
 * Phase 3 of the multi-relay plan. Every write tool:
 *   1. Builds the event once.
 *   2. Calls `gateWrite` (Phase 1) to enforce mode / dryRun / confirm.
 *   3. Calls `pool.signedFetchEach` to fan out across configured relays.
 *   4. Returns `{status: "ok", posts: [{relay, accepted, ...}]}`.
 *
 * The `posts` array is the canonical Phase 3 response shape. Single-relay
 * callers will see a one-element array; pure-phase-1 callers (using
 * `signedFetchWithTimeout`) will need to adopt this shape, but the
 * backward-compatible `event_id` (the first accepted relay's id) and
 * `accepted` (true if any relay accepted) are still present in the JSON.
 */

import type { Mode } from "../config/schema.js";
import type { RelayPool, RelayResponse } from "../relay/pool.js";
import { gateToMcpBody, gateWrite, type UnsignedEventPayload } from "../util/mode.js";

export interface PoolWriteOptions {
  mode: Mode;
  /** Extras passed to the gate. */
  confirm?: boolean;
  dryRun?: boolean;
  /** Optional per-call relay list. Default: fan out to all configured relays. */
  relays?: string[];
  /** Disable fan-out. When false, only the default relay is called. */
  allowFanout?: boolean;
  /** Human-readable preview for the pending-confirm log line. */
  preview: string;
  /** Tool name (used for stats logging). */
  tool: string;
  /**
   * Per-tool extra fields merged into the MCP response body. Backward
   * compatibility with the v0.1.x response shape (e.g. `channel` for
   * post_message, `target` for edit_message, `emoji` for react).
   */
  responseExtras?: Record<string, unknown>;
}

export interface PoolWriteResult {
  /** The signed event payload (id, sig, etc.). */
  event: UnsignedEventPayload & { id: string; pubkey: string; sig: string };
  /** Per-relay responses. */
  posts: RelayResponse[];
  /** True if at least one relay accepted the event. */
  accepted: boolean;
  /** The event id of the first accepted relay (the preferred id). */
  event_id: string;
}

/**
 * Fan out a signed write across the pool. Returns the full response.
 * The caller can return the result directly to the MCP client.
 */
export async function poolWrite(
  pool: RelayPool | undefined,
  event: PoolWriteResult["event"],
  opts: PoolWriteOptions,
): Promise<{
  mcpBody: string;
  result: PoolWriteResult | null;
  isError: boolean;
}> {
  const gate = gateWrite({
    mode: opts.mode,
    confirm: opts.confirm,
    dryRun: opts.dryRun,
    unsigned: event,
    preview: opts.preview,
  });

  if (gate.kind === "read-only") {
    return { mcpBody: "", result: null, isError: true };
  }
  if (gate.kind === "dry-run" || gate.kind === "pending-confirm") {
    return {
      mcpBody: gateToMcpBody(gate, opts.responseExtras ?? {}),
      result: null,
      isError: false,
    };
  }

  if (pool === undefined) {
    return { mcpBody: "RelayPool not configured.", result: null, isError: true };
  }

  const posts = await pool.signedFetchEach({
    method: "POST",
    url: `${pool.list()[0] ?? "https://coreprt.webrnds.com"}/events`,
    body: JSON.stringify(event),
    headers: { "content-type": "application/json" },
    relays: opts.relays,
    allowFanout: opts.allowFanout,
  });

  const accepted = posts.find((p) => p.ok);
  const result: PoolWriteResult = {
    event,
    posts,
    accepted: accepted !== undefined,
    event_id: accepted?.event_id ?? posts[0]?.event_id ?? "",
  };

  // If no event_id was returned, surface the raw body for the operator
  // to inspect. Matches v0.1.x behavior.
  if (result.event_id === "" && posts[0] !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(posts[0].bodyText);
    } catch {
      raw = posts[0].bodyText;
    }
    opts.responseExtras ??= {};
    opts.responseExtras["raw"] = raw;
  }

  const mcpBody = JSON.stringify(
    {
      status: "ok",
      event_id: result.event_id,
      accepted: result.accepted,
      posts: result.posts,
      ...(opts.responseExtras ?? {}),
    },
    null,
    2,
  );

  // If ANY relay returned a non-2xx, surface the first one as a tool error.
  // This preserves the v0.1.x behavior where a 4xx from the relay threw
  // instead of returning silently. The fan-out semantics: every 2xx is
  // counted; the first hard failure is the error.
  if (result.posts.length > 0) {
    const firstFailure = result.posts.find((p) => p.status < 200 || p.status >= 300);
    if (firstFailure !== undefined) {
      const message =
        firstFailure.error ??
        `relay rejected event: HTTP ${firstFailure.status} — ${firstFailure.bodyText.slice(0, 500)}`;
      throw new Error(message);
    }
  }

  return { mcpBody, result, isError: false };
}

/**
 * Convert a pool-write result into the standard MCP `content` envelope.
 * If `isError` is true, throw an Error so the MCP transport surfaces it
 * as a tool error (`isError: true` in the response).
 */
export function poolWriteToMcpContent(
  body: string,
  isError: boolean,
): { content: Array<{ type: "text"; text: string }> } {
  if (isError) {
    throw new Error(body);
  }
  return { content: [{ type: "text", text: body }] };
}
