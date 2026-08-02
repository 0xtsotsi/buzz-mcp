/**
 * Mode enforcement + dry-run helper for write tools.
 *
 * Phase 1 of the multi-relay plan introduces `BUZZ_MCP_MODE` and `dryRun`:
 *   - `read-only`            — every write tool rejects at dispatch.
 *   - `mutate-with-confirm` — write tools log the unsigned event JSON to
 *                              stderr at WARN and return `{status: 'pending-confirm'}`
 *                              unless the caller passes `confirm: true`.
 *   - `mutate`               — write tools sign and post immediately (today's
 *                              behavior, kept for opt-out).
 *
 * Plus the per-call `dryRun: true` flag — never signs, never posts; returns
 * the unsigned event JSON for inspection.
 *
 * This helper is the single chokepoint. Every write tool calls `gateWrite`
 * before any side-effect (signing, fetching, etc). The gate's return value is
 * a discriminated union that the caller pattern-matches on.
 *
 * Pure: no IO, no MCP types. The only side-effect is the optional `logWarn`
 * sink, which defaults to `console.error` (stderr) and is replaceable for
 * tests.
 */
import type { Mode } from "../config/schema.js";

/**
 * The unsigned event payload that the caller would post. We keep it
 * intentionally untyped so `gateWrite` can wrap any event-builder result.
 */
export interface UnsignedEventPayload {
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly created_at?: number;
}

/**
 * Outcome of `gateWrite`. Three possible shapes:
 *   - `{ kind: 'allow' }`                           — proceed with sign + post.
 *   - `{ kind: 'pending-confirm', unsigned, msg }`   — `mutate-with-confirm`
 *                                                      mode was active and
 *                                                      `confirm` was not set.
 *                                                      Caller should return
 *                                                      the `msg` directly.
 *   - `{ kind: 'dry-run', unsigned }`                — `dryRun` was true.
 *                                                      Caller should return
 *                                                      the unsigned event JSON.
 *   - `{ kind: 'read-only', message }`               — `read-only` mode is
 *                                                      active. Caller should
 *                                                      throw the message.
 */
export type GateResult =
  | { kind: "allow" }
  | { kind: "pending-confirm"; readonly unsigned: UnsignedEventPayload; readonly message: string }
  | { kind: "dry-run"; readonly unsigned: UnsignedEventPayload }
  | { kind: "read-only"; readonly message: string };

/**
 * Sink for the WARN log emitted in `mutate-with-confirm` mode. Replaced
 * in tests; defaults to `console.error` (stderr).
 */
export type WarnLog = (line: string) => void;

const defaultWarn: WarnLog = (line) => console.error(line);

export interface GateOptions {
  readonly mode: Mode;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
  /**
   * The unsigned event payload that *would* be signed and posted. Required
   * if `mode === 'mutate-with-confirm'` or `dryRun === true`; otherwise
   * ignored.
   */
  readonly unsigned?: UnsignedEventPayload;
  /** Human-readable preview used in the pending-confirm message. */
  readonly preview?: string;
  /** Warn sink for the pending-confirm log line. */
  readonly warn?: WarnLog;
}

/**
 * Decide whether a write tool may proceed.
 *
 * Behavior:
 *   - `read-only` mode → reject with a clear message.
 *   - `dryRun === true` → return the unsigned event payload without signing.
 *   - `mutate-with-confirm` mode + `confirm !== true` → log the unsigned event
 *     at WARN and return `{status: 'pending-confirm'}`.
 *   - Otherwise (`mutate` mode, or `mutate-with-confirm` + `confirm: true`) →
 *     `{kind: 'allow'}`.
 *
 * The caller is responsible for turning `GateResult` into the right MCP
 * response. Helper builders live below.
 */
export function gateWrite(opts: GateOptions): GateResult {
  const warn = opts.warn ?? defaultWarn;

  if (opts.mode === "read-only") {
    return {
      kind: "read-only",
      message:
        "MCP is in read-only mode (BUZZ_MCP_MODE=read-only). Set BUZZ_MCP_MODE=mutate or BUZZ_MCP_MODE=mutate-with-confirm to enable writes.",
    };
  }

  if (opts.dryRun === true) {
    if (opts.unsigned === undefined) {
      throw new Error("gateWrite: dryRun=true requires `unsigned` event payload");
    }
    return { kind: "dry-run", unsigned: opts.unsigned };
  }

  if (opts.mode === "mutate-with-confirm" && opts.confirm !== true) {
    if (opts.unsigned === undefined) {
      throw new Error(
        "gateWrite: mutate-with-confirm mode requires `unsigned` event payload to log",
      );
    }
    const preview = opts.preview ?? "[no preview]";
    warn(
      `[buzz-mcp] mutate-with-confirm: ${preview}\n` +
        `  unsigned event: ${JSON.stringify(opts.unsigned)}\n` +
        `  re-call with confirm: true to actually post.`,
    );
    return {
      kind: "pending-confirm",
      unsigned: opts.unsigned,
      message:
        "Write pending confirmation. Re-call with confirm: true to publish. The unsigned event was logged to stderr.",
    };
  }

  return { kind: "allow" };
}

/**
 * Convenience: build the MCP `content` payload for a gate result.
 *
 * Tool handlers should switch on `gate.kind`:
 *   - `allow`            → call the sign+post path.
 *   - `pending-confirm`  → return `gateToMcpContent(result, …)` to surface
 *                          the message; the caller treats this as a
 *                          *non-error* result (the write did not happen).
 *   - `dry-run`          → return `gateToMcpContent(result, …)` to expose
 *                          the unsigned event JSON.
 *   - `read-only`        → throw `result.message` as an MCP tool error.
 *
 * The `extra` field is merged into the JSON body so callers can add their
 * own fields (e.g. `{channel: 'general'}` on pending-confirm responses).
 */
export function gateToMcpBody(result: GateResult, extra: Record<string, unknown> = {}): string {
  switch (result.kind) {
    case "allow":
      // Should never reach here — callers branch on `allow` before this.
      return JSON.stringify({ status: "ok", ...extra });
    case "pending-confirm":
      return JSON.stringify({
        status: "pending-confirm",
        message: result.message,
        unsigned_event: result.unsigned,
        ...extra,
      });
    case "dry-run":
      return JSON.stringify({
        status: "dry-run",
        unsigned_event: result.unsigned,
        ...extra,
      });
    case "read-only":
      return JSON.stringify({ error: result.message, ...extra });
  }
}
