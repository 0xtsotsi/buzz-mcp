/**
 * Per-relay stats for `@buzz/mcp`.
 *
 * Phase 2 of the multi-relay plan. Every signed fetch records its outcome
 * into a `RelayStats` for the destination relay. The stats are accumulated
 * in-memory and exposed via the new `buzz_get_stats` MCP tool.
 *
 * Design:
 *   - One record per relay URL. URLs are lower-cased at insert time so
 *     `https://x.test` and `https://x.test/` map to the same record.
 *   - Latency distribution is a fixed-size ring buffer of recent samples
 *     (constant memory). `p50` / `p95` are computed on demand.
 *   - The stats module is process-local. Multi-process deployments (which
 *     is not the @buzz/mcp model — there is one process per agent) would
 *     need a shared sink; that is out of scope.
 */
import type { Logger } from "../util/log.js";

/**
 * Buckets for response status. The plan calls these out by name:
 *   - `rejected_400`: bad request, almost always a payload bug.
 *   - `rejected_401`: NIP-98 replay detected (token already used).
 *   - `rejected_403`: forbidden, almost always a permission denial.
 *   - `timeout`: 5s deadline exceeded.
 *   - Other 4xx/5xx fall into the `rejected_other` bucket.
 *   - `success`: 2xx.
 *   - `network_error`: DNS / TCP / TLS failure.
 */
export type Outcome =
  | "success"
  | "rejected_400"
  | "rejected_401"
  | "rejected_403"
  | "rejected_other"
  | "timeout"
  | "network_error";

/** Per-relay stats. */
export interface RelayStats {
  readonly url: string;
  /** Total signedFetch calls against this relay. */
  calls_total: number;
  /** Successful 2xx responses. */
  success: number;
  /** HTTP 400 responses. */
  rejected_400: number;
  /** HTTP 401 responses. */
  rejected_401: number;
  /** HTTP 403 responses. */
  rejected_403: number;
  /** Other 4xx/5xx responses. */
  rejected_other: number;
  /** Timeouts. */
  timeout: number;
  /** Network errors (DNS, TCP, TLS). */
  network_error: number;
  /** Median latency in ms across the recent window. */
  latency_p50_ms: number;
  /** 95th percentile latency in ms across the recent window. */
  latency_p95_ms: number;
  /** Unix ms timestamp of the last successful fetch. */
  last_success_at: number | null;
  /** Unix ms timestamp of the last failed fetch. */
  last_error_at: number | null;
}

/** Number of latency samples retained per relay. */
const LATENCY_WINDOW = 200;

/**
 * The stats store. One per MCP server instance. The constructor accepts
 * an optional `logger` so the record lifecycle can be logged.
 */
export class StatsStore {
  private readonly records = new Map<string, RelayStats>();
  private readonly latencies = new Map<string, number[]>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Normalize a URL to its origin (scheme + host + port). Strips trailing
   *  slashes and any path, so `https://x.test/` and `https://x.test/events`
   *  map to the same record. The original URL is preserved on the
   *  `RelayStats.url` field; only the dedupe key is normalized. */
  private normalize(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`.toLowerCase();
    } catch {
      return url.replace(/\/+$/, "").toLowerCase();
    }
  }

  /** Get (or lazily create) the stats record for a relay URL. */
  private getOrCreate(url: string): RelayStats {
    const key = this.normalize(url);
    let record = this.records.get(key);
    if (record === undefined) {
      record = {
        url,
        calls_total: 0,
        success: 0,
        rejected_400: 0,
        rejected_401: 0,
        rejected_403: 0,
        rejected_other: 0,
        timeout: 0,
        network_error: 0,
        latency_p50_ms: 0,
        latency_p95_ms: 0,
        last_success_at: null,
        last_error_at: null,
      };
      this.records.set(key, record);
      this.latencies.set(key, []);
    }
    return record;
  }

  /**
   * Record the outcome of a signed fetch. `latencyMs` is the wall-clock
   * latency of the request; `outcome` is the bucketed result.
   *
   * `latency_ms` is recorded only on success or non-timeout failures —
   * a timeout's latency is meaningless (capped at the 5s deadline).
   */
  record(url: string, outcome: Outcome, latencyMs?: number): void {
    const record = this.getOrCreate(url);
    record.calls_total += 1;

    switch (outcome) {
      case "success":
        record.success += 1;
        record.last_success_at = Date.now();
        break;
      case "rejected_400":
        record.rejected_400 += 1;
        record.last_error_at = Date.now();
        break;
      case "rejected_401":
        record.rejected_401 += 1;
        record.last_error_at = Date.now();
        break;
      case "rejected_403":
        record.rejected_403 += 1;
        record.last_error_at = Date.now();
        break;
      case "rejected_other":
        record.rejected_other += 1;
        record.last_error_at = Date.now();
        break;
      case "timeout":
        record.timeout += 1;
        record.last_error_at = Date.now();
        break;
      case "network_error":
        record.network_error += 1;
        record.last_error_at = Date.now();
        break;
    }

    if (latencyMs !== undefined && outcome !== "timeout") {
      const key = this.normalize(url);
      const buffer = this.latencies.get(key) ?? [];
      buffer.push(latencyMs);
      if (buffer.length > LATENCY_WINDOW) {
        buffer.shift();
      }
      this.latencies.set(key, buffer);
      const { p50, p95 } = computePercentiles(buffer);
      record.latency_p50_ms = p50;
      record.latency_p95_ms = p95;
    }

    this.logger.debug("stats.record", {
      relay: url,
      outcome,
      latency_ms: latencyMs,
      calls_total: record.calls_total,
    });
  }

  /** Snapshot all stats. Returns a frozen array. */
  snapshot(): readonly RelayStats[] {
    return Object.freeze([...this.records.values()].map((r) => Object.freeze({ ...r })));
  }

  /** Snapshot for a single relay. Returns `null` if no calls have been recorded. */
  forRelay(url: string): RelayStats | null {
    const key = this.normalize(url);
    const record = this.records.get(key);
    if (record === undefined) return null;
    return Object.freeze({ ...record });
  }

  /** Reset all stats. Useful for tests. */
  reset(): void {
    this.records.clear();
    this.latencies.clear();
  }
}

/**
 * Compute the p50 and p95 of a numeric array. Returns `{ p50: 0, p95: 0 }`
 * for an empty array. The array is sorted in-place; callers should pass a
 * copy if they need to preserve order.
 */
export function computePercentiles(samples: readonly number[]): { p50: number; p95: number } {
  if (samples.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
  };
}

/**
 * Map a HTTP status code to a stats outcome. Returns `network_error` for
 * non-response failures (caller is responsible for that case).
 */
export function outcomeFromStatus(
  status: number,
): Extract<
  Outcome,
  "success" | "rejected_400" | "rejected_401" | "rejected_403" | "rejected_other"
> {
  if (status >= 200 && status < 300) return "success";
  if (status === 400) return "rejected_400";
  if (status === 401) return "rejected_401";
  if (status === 403) return "rejected_403";
  return "rejected_other";
}
