/**
 * Unit tests for `src/relay/pool.ts` — the multi-relay pool.
 *
 * Phase 3 of the multi-relay plan. The pool is the heart of fan-out;
 * every write tool goes through it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayPool } from "../../src/relay/pool.js";
import { StatsStore } from "../../src/relay/stats.js";
import { createLogger, setLogger } from "../../src/util/log.js";

const SECRET = "a".repeat(64);

function makePool(opts: {
  relays: string[];
  fetchImpl?: typeof fetch;
  secret?: string;
}): RelayPool {
  const stats = new StatsStore(createLogger({ level: "error" }));
  return new RelayPool({
    relays: opts.relays,
    defaultRelay: opts.relays[0]!,
    relayHosts: {},
    secret: (opts.secret ?? SECRET) as never,
    stats,
    channelCacheTtlMs: 5 * 60 * 1000,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

function makeFetchSpy(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init: init ?? {} });
    return impl(u, init ?? {});
  });
  return { spy, calls };
}

beforeEach(() => {
  setLogger(createLogger({ level: "error" }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RelayPool.list", () => {
  it("returns the configured relays", () => {
    const pool = makePool({ relays: ["https://a.test", "https://b.test"] });
    expect(pool.list()).toEqual(["https://a.test", "https://b.test"]);
  });
});

describe("RelayPool.signedFetchEach — fan-out", () => {
  it("fans out to all configured relays by default", async () => {
    const { spy, calls } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    const pool = makePool({
      relays: ["https://a.test", "https://b.test"],
      fetchImpl: spy as unknown as typeof fetch,
    });
    const posts = await pool.signedFetchEach({
      method: "POST",
      url: "https://a.test/events",
      body: JSON.stringify({ kind: 9 }),
      headers: { "content-type": "application/json" },
    });
    expect(posts).toHaveLength(2);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://a.test/events",
      "https://b.test/events",
    ]);
  });

  it("only calls the default relay when allowFanout is false", async () => {
    const { spy, calls } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    const pool = makePool({
      relays: ["https://a.test", "https://b.test"],
      fetchImpl: spy as unknown as typeof fetch,
    });
    const posts = await pool.signedFetchEach({
      method: "POST",
      url: "https://a.test/events",
      body: "",
      headers: {},
      allowFanout: false,
    });
    expect(posts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://a.test/events");
  });

  it("uses opts.relays to override the pool default", async () => {
    const { spy, calls } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    const pool = makePool({
      relays: ["https://a.test", "https://b.test"],
      fetchImpl: spy as unknown as typeof fetch,
    });
    const posts = await pool.signedFetchEach({
      method: "POST",
      url: "https://a.test/events",
      body: "",
      headers: {},
      relays: ["https://b.test"],
    });
    expect(posts).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://b.test/events");
  });

  it("survives a single relay failure (the others proceed)", async () => {
    const { spy } = makeFetchSpy(async (url) => {
      if (url.includes("a.test")) {
        return new Response("nope", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 });
    });
    const pool = makePool({
      relays: ["https://a.test", "https://b.test"],
      fetchImpl: spy as unknown as typeof fetch,
    });
    const posts = await pool.signedFetchEach({
      method: "POST",
      url: "https://a.test/events",
      body: "",
      headers: {},
    });
    expect(posts).toHaveLength(2);
    const a = posts.find((p) => p.url === "https://a.test")!;
    const b = posts.find((p) => p.url === "https://b.test")!;
    expect(a.ok).toBe(false);
    expect(a.status).toBe(500);
    expect(b.ok).toBe(true);
    expect(b.status).toBe(202);
  });

  it("records every outcome into the stats store", async () => {
    const { spy } = makeFetchSpy(async (url) => {
      if (url.includes("a.test")) {
        return new Response("nope", { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 });
    });
    const stats = new StatsStore(createLogger({ level: "error" }));
    const pool = new RelayPool({
      relays: ["https://a.test", "https://b.test"],
      defaultRelay: "https://a.test",
      relayHosts: {},
      secret: SECRET as never,
      stats,
      channelCacheTtlMs: 5 * 60 * 1000,
      fetchImpl: spy as unknown as typeof fetch,
    });
    await pool.signedFetchEach({
      method: "POST",
      url: "https://a.test/events",
      body: "",
      headers: {},
    });
    const snap = stats.snapshot();
    expect(snap).toHaveLength(2);
    const a = snap.find((s) => s.url === "https://a.test")!;
    expect(a.success).toBe(0);
    expect(a.rejected_401).toBe(1);
  });
});

describe("RelayPool.nip11Info", () => {
  it("returns null when the relay is unreachable", async () => {
    const pool = makePool({
      relays: ["https://nope.test"],
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    const info = await pool.nip11Info("https://nope.test");
    expect(info).toBeNull();
  });

  it("returns the parsed NIP-11 document on success", async () => {
    const pool = makePool({
      relays: ["https://a.test"],
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            supported_nips: [1, 9, 11],
            description: "test relay",
            limitation: { max_message_length: 32768 },
          }),
          { status: 200, headers: { "content-type": "application/nostr+json" } },
        )) as unknown as typeof fetch,
    });
    const info = await pool.nip11Info("https://a.test");
    expect(info).not.toBeNull();
    expect(info!.supported_nips).toEqual([1, 9, 11]);
    expect(info!.description).toBe("test relay");
    expect(info!.limitation_max_message_length).toBe(32768);
  });
});
