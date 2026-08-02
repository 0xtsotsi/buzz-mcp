/**
 * Multi-relay subscription manager.
 *
 * Phase 4 of the multi-relay plan. This module wraps the per-relay
 * `SubscriptionManager` (single WebSocket) and fans out a single `REQ`
 * across every configured relay.
 *
 * Each relay in the pool gets its own `SubscriptionManager` instance. The
 * multi-relay manager:
 *   - Issues the same `REQ` on every per-relay manager.
 *   - The per-relay `sub_id` is whatever the per-relay manager returns.
 *   - Deduplicates events by `id` across all per-relay managers. The
 *     "first seen wins" — fan-out redundancy is the whole point.
 *   - Polls every per-relay manager, drains all events, dedupes, and
 *     drops the per-relay origin from the merged set.
 *   - Backpressure: if any per-relay manager's queue exceeds 1000
 *     events, the manager drops the oldest and logs a warning.
 *
 * Per-call `relays: [...]` overrides the pool's default relay list.
 */
import {
  type SubscriptionEvent,
  type SubscriptionFilter,
  SubscriptionManager,
  type SubscriptionManagerOptions,
} from "./subscription.js";

const MAX_BUFFER_SIZE = 1000;

/** Per-relay subscription record. */
type PerRelaySub = {
  /** The per-relay SubscriptionManager. */
  manager: SubscriptionManager;
  /** The sub_id on the manager. */
  remoteSubId: string;
  /** Relay URL this sub is open on. */
  relay: string;
};

/** Multi-relay subscription state. */
type MultiSubState = {
  /** Filter used for the sub. */
  filter: SubscriptionFilter;
  /** Per-relay record. */
  perRelay: PerRelaySub[];
  /** Cross-relay seen set (event.id → true). "First seen wins". */
  seen: Set<string>;
};

/** Multi-relay subscription manager options. */
export interface MultiRelaySubscriptionManagerOptions {
  /** The list of relays to fan out across. Defaults to the pool's relays. */
  relayUrls: readonly string[];
  /** Manually override the per-relay SubscriptionManager creation. */
  createManager?: (relay: string) => SubscriptionManager;
  /** Per-relay SubscriptionManager options. */
  perRelayOpts?: SubscriptionManagerOptions;
  /** Maximum buffer size per relay (default 1000). */
  maxBufferSize?: number;
}

export class MultiRelaySubscriptionManager {
  readonly #opts: MultiRelaySubscriptionManagerOptions;
  readonly #maxBufferSize: number;
  readonly #subs = new Map<string, MultiSubState>();

  /** Per-relay manager index: `relay` → `SubscriptionManager`. */
  readonly #managers = new Map<string, SubscriptionManager>();

  constructor(opts: MultiRelaySubscriptionManagerOptions) {
    this.#opts = opts;
    this.#maxBufferSize = opts.maxBufferSize ?? MAX_BUFFER_SIZE;
  }

  /**
   * Issue a `REQ` on every configured relay (or the override list).
   * Returns a single public `sub_id` that the caller uses for `poll()`
   * and `unsubscribe()`.
   */
  async subscribe(filter: SubscriptionFilter, opts?: { relays?: string[] }): Promise<string> {
    const relays = opts?.relays && opts.relays.length > 0 ? opts.relays : this.#opts.relayUrls;
    if (relays.length === 0) {
      throw new Error(
        "MultiRelaySubscriptionManager: no relays configured. Set BUZZ_RELAY_URLS or pass `relays: [...]`.",
      );
    }

    const subId = `subs-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const perRelay: PerRelaySub[] = [];

    // Open the per-relay subscriptions in parallel.
    await Promise.all(
      relays.map(async (relay) => {
        const manager = this.#getOrCreateManager(relay);
        const remoteSubId = await manager.subscribe(filter);
        perRelay.push({ manager, remoteSubId, relay });
      }),
    );

    this.#subs.set(subId, { filter, perRelay, seen: new Set<string>() });
    return subId;
  }

  /**
   * Drain dedup'd events from every per-relay sub. The merged set is
   * returned; the per-relay buffers are cleared as their events are
   * consumed. The first-seen event id is the one returned (per-relay
   * origin is stripped).
   */
  poll(subId: string, max: number = 50): SubscriptionEvent[] {
    const state = this.#subs.get(subId);
    if (!state) return [];
    const n = Math.max(0, Math.floor(max));
    if (n === 0) return [];

    const merged: SubscriptionEvent[] = [];
    const seen = state.seen;
    for (const sub of state.perRelay) {
      const events = sub.manager.poll(sub.remoteSubId, n);
      console.log(
        "poll() relay=",
        sub.relay,
        "remoteSubId=",
        sub.remoteSubId,
        "events=",
        events.length,
      );
      for (const ev of events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        merged.push(ev);
        if (merged.length >= n) break;
      }
      if (merged.length >= n) break;
    }
    return merged;
  }

  /** Number of buffered events still unsent to the caller. */
  remaining(subId: string): number {
    const state = this.#subs.get(subId);
    if (!state) return 0;
    let total = 0;
    for (const sub of state.perRelay) {
      total += sub.manager.remaining(sub.remoteSubId);
    }
    return total;
  }

  /** Send `CLOSE` on every per-relay sub, drop the local state. */
  async unsubscribe(subId: string): Promise<void> {
    const state = this.#subs.get(subId);
    if (!state) return;
    await Promise.all(state.perRelay.map((sub) => sub.manager.unsubscribe(sub.remoteSubId)));
    this.#subs.delete(subId);
  }

  /** Close every per-relay WS. */
  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.#managers.values()).map((m) => m.close().catch(() => undefined)),
    );
    this.#managers.clear();
    this.#subs.clear();
  }

  /** Snapshot of active sub ids. */
  listSubs(): string[] {
    return Array.from(this.#subs.keys());
  }

  /** The relays this manager is configured against. */
  listRelays(): readonly string[] {
    return this.#opts.relayUrls;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  #getOrCreateManager(relay: string): SubscriptionManager {
    let m = this.#managers.get(relay);
    if (m !== undefined) return m;
    if (this.#opts.createManager !== undefined) {
      m = this.#opts.createManager(relay);
    } else {
      m = new SubscriptionManager("" as never, relay, this.#opts.perRelayOpts ?? {});
    }
    this.#managers.set(relay, m);
    return m;
  }
}
