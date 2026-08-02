/**
 * Unit tests for `src/relay/stats.ts` — the per-relay stats store.
 *
 * Phase 2 of the multi-relay plan. The store is the source of truth for
 * every `buzz_get_stats` response.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computePercentiles, outcomeFromStatus, StatsStore } from "../../src/relay/stats.js";
import { createLogger } from "../../src/util/log.js";

function makeStore(): { store: StatsStore; stderr: string[] } {
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(typeof s === "string" ? s : (s as Buffer).toString());
    return true;
  });
  const store = new StatsStore(createLogger({ level: "error" }));
  return { store, stderr };
}

describe("StatsStore — record + snapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("starts empty", () => {
    const { store } = makeStore();
    expect(store.snapshot()).toEqual([]);
  });

  it("records success and updates last_success_at", () => {
    const { store } = makeStore();
    const before = Date.now();
    store.record("https://x.test/", "success", 30);
    const after = Date.now();
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    const s = snap[0]!;
    expect(s.url).toBe("https://x.test/");
    expect(s.calls_total).toBe(1);
    expect(s.success).toBe(1);
    expect(s.last_success_at).toBeGreaterThanOrEqual(before);
    expect(s.last_success_at).toBeLessThanOrEqual(after);
  });

  it("dedupes relay URLs (origin-only, case-insensitive, ignores path)", () => {
    const { store } = makeStore();
    store.record("https://X.test/path1", "success", 10);
    store.record("https://x.test/path2", "success", 20);
    store.record("https://X.test/path3", "rejected_401", 5);
    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.calls_total).toBe(3);
    expect(snap[0]!.success).toBe(2);
    expect(snap[0]!.rejected_401).toBe(1);
  });

  it("buckets all outcome types", () => {
    const { store } = makeStore();
    store.record("https://x.test", "success", 10);
    store.record("https://x.test", "rejected_400", 10);
    store.record("https://x.test", "rejected_401", 10);
    store.record("https://x.test", "rejected_403", 10);
    store.record("https://x.test", "rejected_other", 10);
    store.record("https://x.test", "timeout", 5000);
    store.record("https://x.test", "network_error", 5);
    const s = store.snapshot()[0]!;
    expect(s).toMatchObject({
      calls_total: 7,
      success: 1,
      rejected_400: 1,
      rejected_401: 1,
      rejected_403: 1,
      rejected_other: 1,
      timeout: 1,
      network_error: 1,
    });
  });

  it("computes p50 and p95 from the latency window", () => {
    const { store } = makeStore();
    for (let i = 1; i <= 100; i++) {
      store.record("https://x.test", "success", i);
    }
    const s = store.snapshot()[0]!;
    expect(s.latency_p50_ms).toBeGreaterThanOrEqual(50);
    expect(s.latency_p50_ms).toBeLessThanOrEqual(51);
    expect(s.latency_p95_ms).toBeGreaterThanOrEqual(95);
    expect(s.latency_p95_ms).toBeLessThanOrEqual(96);
  });

  it("does not record latency for timeouts (the cap is meaningless)", () => {
    const { store } = makeStore();
    store.record("https://x.test", "timeout", 5000);
    expect(store.snapshot()[0]!.latency_p95_ms).toBe(0);
  });

  it("forRelay returns null for unknown URLs", () => {
    const { store } = makeStore();
    expect(store.forRelay("https://nope.test")).toBeNull();
  });

  it("forRelay returns the stats for a known URL", () => {
    const { store } = makeStore();
    store.record("https://x.test", "success", 10);
    expect(store.forRelay("https://x.test")?.calls_total).toBe(1);
  });

  it("reset clears all records", () => {
    const { store } = makeStore();
    store.record("https://x.test", "success", 10);
    store.reset();
    expect(store.snapshot()).toEqual([]);
  });

  it("snapshot returns frozen objects (immutable to callers)", () => {
    const { store } = makeStore();
    store.record("https://x.test", "success", 10);
    const s = store.snapshot()[0]!;
    expect(() => {
      (s as { calls_total: number }).calls_total = 999;
    }).toThrow();
  });
});

describe("computePercentiles", () => {
  it("returns {p50:0, p95:0} for empty input", () => {
    expect(computePercentiles([])).toEqual({ p50: 0, p95: 0 });
  });

  it("handles single-element arrays", () => {
    expect(computePercentiles([42])).toEqual({ p50: 42, p95: 42 });
  });

  it("handles 100-element sorted arrays", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    const { p50, p95 } = computePercentiles(arr);
    expect(p50).toBeGreaterThanOrEqual(50);
    expect(p50).toBeLessThanOrEqual(51);
    expect(p95).toBeGreaterThanOrEqual(95);
    expect(p95).toBeLessThanOrEqual(96);
  });

  it("does not mutate the input array", () => {
    const arr = [3, 1, 2];
    computePercentiles(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});

describe("outcomeFromStatus", () => {
  it("maps 2xx to success", () => {
    expect(outcomeFromStatus(200)).toBe("success");
    expect(outcomeFromStatus(202)).toBe("success");
    expect(outcomeFromStatus(299)).toBe("success");
  });
  it("maps 400/401/403 to their buckets", () => {
    expect(outcomeFromStatus(400)).toBe("rejected_400");
    expect(outcomeFromStatus(401)).toBe("rejected_401");
    expect(outcomeFromStatus(403)).toBe("rejected_403");
  });
  it("maps other 4xx/5xx to rejected_other", () => {
    expect(outcomeFromStatus(404)).toBe("rejected_other");
    expect(outcomeFromStatus(500)).toBe("rejected_other");
    expect(outcomeFromStatus(503)).toBe("rejected_other");
  });
});
