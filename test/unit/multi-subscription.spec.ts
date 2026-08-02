/**
 * Unit tests for `src/relay/multi-subscription.ts`.
 *
 * Phase 4 of the multi-relay plan. The multi-relay manager fans out a
 * single `REQ` across every configured relay, then dedupes by `id` on
 * poll. The dedup is "first seen wins" — the test forces the same event
 * to arrive from two relays and verifies only one is returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MultiRelaySubscriptionManager } from "../../src/relay/multi-subscription.js";
import type { SubscriptionManager } from "../../src/relay/subscription.js";

type FakeEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

function makeEvent(id: string): FakeEvent {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "hi",
    sig: "b".repeat(128),
  };
}

function makeMockManager(
  opts: { eventsPerSub?: Map<string, FakeEvent[]>; remoteSubId?: string } = {},
) {
  const remoteSubId = opts.remoteSubId ?? "auto-sub-id";
  const eventsPerSub = opts.eventsPerSub ?? new Map<string, FakeEvent[]>();
  const subscribed = new Set<string>();
  const unsubscribed = new Set<string>();
  const closed = vi.fn(async () => {});
  const subscribe = vi.fn(async (_filter: unknown, _opts?: unknown) => {
    const id = remoteSubId;
    if (!eventsPerSub.has(id)) eventsPerSub.set(id, []);
    subscribed.add(id);
    return id;
  });
  const unsubscribe = vi.fn(async (id: string) => {
    unsubscribed.add(id);
  });
  const poll = vi.fn((id: string, max: number) => {
    const events = eventsPerSub.get(id) ?? [];
    return events.splice(0, max);
  });
  const remaining = vi.fn((id: string) => eventsPerSub.get(id)?.length ?? 0);
  return {
    manager: {
      subscribe,
      unsubscribe,
      poll,
      remaining,
      close: closed,
      // unused
    } as unknown as SubscriptionManager,
    callbacks: { subscribe, unsubscribe, poll, remaining, closed, subscribed, unsubscribed },
  };
}

describe("MultiRelaySubscriptionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when no relays are configured", async () => {
    const mgr = new MultiRelaySubscriptionManager({ relayUrls: [] });
    await expect(mgr.subscribe({ kinds: [1] })).rejects.toThrow(/no relays configured/);
  });

  it("calls subscribe on every per-relay manager", async () => {
    const a = makeMockManager();
    const b = makeMockManager();
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test", "https://b.test"],
      createManager: (relay) => (relay.includes("a") ? a.manager : b.manager),
    });
    await mgr.subscribe({ kinds: [1] });
    expect(a.callbacks.subscribe).toHaveBeenCalledOnce();
    expect(b.callbacks.subscribe).toHaveBeenCalledOnce();
  });

  it("polls events from a single relay when only one relay is configured", async () => {
    const events = new Map<string, FakeEvent[]>([["auto-sub-id", [makeEvent("e1")]]]);
    const m = makeMockManager({ eventsPerSub: events });
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test"],
      createManager: () => m.manager,
    });
    const subId = await mgr.subscribe({ kinds: [1] });
    const polled = mgr.poll(subId);
    expect(polled).toHaveLength(1);
    expect(polled[0]?.id).toBe("e1");
  });

  it("dedupes events by id across relays", async () => {
    // Both relays return the SAME event id. The dedup should drop the second.
    const eventsA = new Map<string, FakeEvent[]>([
      ["auto-sub-id", [makeEvent("e1"), makeEvent("e2")]],
    ]);
    const eventsB = new Map<string, FakeEvent[]>([
      ["auto-sub-id", [makeEvent("e1"), makeEvent("e3")]],
    ]);
    const a = makeMockManager({ eventsPerSub: eventsA });
    const b = makeMockManager({ eventsPerSub: eventsB });
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test", "https://b.test"],
      createManager: (relay) => (relay.includes("a") ? a.manager : b.manager),
    });
    const subId = await mgr.subscribe({ kinds: [1] });
    const polled = mgr.poll(subId, 10);
    const ids = polled.map((e) => e.id).sort();
    expect(ids).toEqual(["e1", "e2", "e3"]);
    // e1 should appear exactly once (deduped).
    expect(ids.filter((id) => id === "e1")).toHaveLength(1);
  });

  it("remaining sums events across all per-relay subs", async () => {
    const eventsA = new Map<string, FakeEvent[]>([
      ["auto-sub-id", [makeEvent("e1"), makeEvent("e2")]],
    ]);
    const eventsB = new Map<string, FakeEvent[]>([["auto-sub-id", [makeEvent("e3")]]]);
    const a = makeMockManager({ eventsPerSub: eventsA });
    const b = makeMockManager({ eventsPerSub: eventsB });
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test", "https://b.test"],
      createManager: (relay) => (relay.includes("a") ? a.manager : b.manager),
    });
    const subId = await mgr.subscribe({ kinds: [1] });
    expect(mgr.remaining(subId)).toBe(3);
    mgr.poll(subId, 10);
    expect(mgr.remaining(subId)).toBe(0);
  });

  it("unsubscribe sends CLOSE on every per-relay sub", async () => {
    const a = makeMockManager();
    const b = makeMockManager();
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test", "https://b.test"],
      createManager: (relay) => (relay.includes("a") ? a.manager : b.manager),
    });
    const subId = await mgr.subscribe({ kinds: [1] });
    await mgr.unsubscribe(subId);
    expect(a.callbacks.unsubscribe).toHaveBeenCalledWith("auto-sub-id");
    expect(b.callbacks.unsubscribe).toHaveBeenCalledWith("auto-sub-id");
    expect(mgr.listSubs()).toEqual([]);
  });

  it("per-call relays override the configured list", async () => {
    const a = makeMockManager();
    const b = makeMockManager();
    const c = makeMockManager();
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test", "https://b.test", "https://c.test"],
      createManager: (relay) => {
        if (relay.includes("a")) return a.manager;
        if (relay.includes("b")) return b.manager;
        return c.manager;
      },
    });
    await mgr.subscribe({ kinds: [1] }, { relays: ["https://a.test"] });
    expect(a.callbacks.subscribe).toHaveBeenCalledOnce();
    expect(b.callbacks.subscribe).not.toHaveBeenCalled();
    expect(c.callbacks.subscribe).not.toHaveBeenCalled();
  });

  it("close shuts down every per-relay manager", async () => {
    const a = makeMockManager();
    const b = makeMockManager();
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test", "https://b.test"],
      createManager: (relay) => (relay.includes("a") ? a.manager : b.manager),
    });
    await mgr.subscribe({ kinds: [1] });
    await mgr.close();
    expect(a.callbacks.closed).toHaveBeenCalledOnce();
    expect(b.callbacks.closed).toHaveBeenCalledOnce();
    expect(mgr.listSubs()).toEqual([]);
  });

  it("listSubs returns the active public sub_ids", async () => {
    const m = makeMockManager();
    const mgr = new MultiRelaySubscriptionManager({
      relayUrls: ["https://a.test"],
      createManager: () => m.manager,
    });
    const s1 = await mgr.subscribe({ kinds: [1] });
    const s2 = await mgr.subscribe({ kinds: [1] });
    expect(mgr.listSubs()).toEqual([s1, s2].sort());
  });
});
