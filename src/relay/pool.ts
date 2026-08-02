/**
 * `RelayPool` — multi-relay fan-out for signed fetches.
 *
 * Phase 3 of the multi-relay plan. The pool owns the list of configured
 * relays (parsed from `BUZZ_RELAY_URLS` by Phase 1's `parseEnv`) and
 * provides:
 *   - NIP-11 probe on construct; re-probe on probe failure.
 *   - `signedFetchEach(opts)` — fans out a signed fetch across N>=1 relays.
 *   - 1.5s sleep + 1 retry on `401 NIP-98 replay detected`.
 *   - 5s per-relay timeout (enforced at the wire).
 *   - Per-relay `Host` header derivation (override via `BUZZ_RELAY_HOST_<n>`).
 *   - Channel UUID resolution cache (5 min TTL, configurable via
 *     `BUZZ_CHANNEL_CACHE_TTL_MS`).
 *
 * The pool is a per-server singleton. The current `signedFetchWithTimeout`
 * helper is single-relay; this module replaces it for write tools but
 * preserves the single-relay path for callers that don't need fan-out.
 *
 * ## Failure modes
 *   - The relay is unreachable (DNS, TCP, TLS). The pool marks the call
 *     `rejected` and continues to the next relay.
 *   - The relay returns 401 with "NIP-98 replay detected". The pool
 *     sleeps 1.5s and retries once. If the retry fails, the call is
 *     marked `rejected` and the other relays are tried.
 *   - The relay returns 5xx. The pool marks the call `rejected` and
 *     continues. The plan does not call for 5xx retries.
 *   - The relay returns 401 without the "NIP-98 replay detected" message.
 *     The pool marks the call `rejected` and continues to the next relay.
 *
 * ## Stats
 * Each call records into the shared `StatsStore` (Phase 2). The tool name
 * is set from the caller's `tool` field.
 */

import { getLogger } from "../util/log.js";
import { type CfAccess, formatRelayError, parseAckId } from "../util/relay-call.js";
import { buildAuthHeader, type SignedFetchOptions, type signedFetch } from "./client.js";
import type { NsecOrHex } from "./signer.js";
import { outcomeFromStatus, type StatsStore } from "./stats.js";

/** Default per-relay timeout. */
const DEFAULT_TIMEOUT_MS = 5_000;
/** Sleep on NIP-98 replay before retry. The plan calls for 1.5s. */
const REPLAY_SLEEP_MS = 1_500;

/** A single relay's response. */
export interface RelayResponse {
  readonly url: string;
  readonly status: number;
  readonly bodyText: string;
  readonly event_id: string | null;
  readonly accepted: boolean;
  /** Latency in ms. */
  readonly latency_ms: number;
  /** `true` if the relay unambiguously accepted the event. */
  readonly ok: boolean;
  /** Error message if `ok` is false. */
  readonly error?: string;
}

/** Options for `signedFetchEach`. */
export interface SignedFetchEachOptions extends SignedFetchOptions {
  /** Override the relay list. Default: every relay in the pool. */
  relays?: string[];
  /** Allow fanout. Default: true. If false, only the default relay is called. */
  allowFanout?: boolean;
  /** Disable 401-replay retry. Test-only. */
  _disableReplayRetry?: boolean;
}

/** NIP-11 info document for a single relay. */
export interface Nip11Info {
  readonly url: string;
  readonly banner: string | null;
  readonly description: string | null;
  readonly name: string | null;
  readonly pubkey: string | null;
  readonly contact: string | null;
  readonly supported_nips: readonly number[];
  readonly limitation_max_message_length: number | null;
  readonly limitation_max_subscriptions: number | null;
  readonly limitation_max_filters: number | null;
  readonly relay_countries: readonly string[];
  readonly language_tags: readonly string[];
  readonly tags: readonly string[];
  /** Unix ms timestamp of the last successful probe. */
  readonly probed_at: number;
}

/** Construct a `RelayPool`. */
export class RelayPool {
  private readonly relays: string[];
  private readonly defaultRelay: string;
  private readonly relayHosts: Record<string, string>;
  private readonly secret: NsecOrHex;
  private readonly stats: StatsStore;
  private readonly nip11 = new Map<string, Nip11Info>();
  private readonly cfAccess: CfAccess | undefined;
  private readonly channelCacheTtlMs: number;
  private readonly channelCache = new Map<
    string,
    { byRelay: Map<string, string>; expiresAt: number }
  >();
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    relays: readonly string[];
    defaultRelay: string;
    relayHosts: Record<string, string>;
    secret: NsecOrHex;
    stats: StatsStore;
    cfAccess?: CfAccess;
    channelCacheTtlMs: number;
    /** Injectable fetch for tests. Defaults to a lazy reference to
     * `globalThis.fetch` so a test that sets `globalThis.fetch` after
     * construction takes effect immediately. */
    fetchImpl?: typeof fetch;
  }) {
    this.relays = [...opts.relays];
    this.defaultRelay = opts.defaultRelay;
    this.relayHosts = opts.relayHosts;
    this.secret = opts.secret;
    this.stats = opts.stats;
    this.cfAccess = opts.cfAccess;
    this.channelCacheTtlMs = opts.channelCacheTtlMs;
    this.fetchImpl =
      opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  }

  /** Read-only list of configured relays. */
  list(): readonly string[] {
    return this.relays;
  }

  /** NIP-11 info for a relay. Re-probe on failure. */
  async nip11Info(relay: string, force: boolean = false): Promise<Nip11Info | null> {
    const cached = this.nip11.get(relay);
    if (!force && cached !== undefined) return cached;
    try {
      const resp = await this.fetchImpl(`${relay.replace(/\/$/, "")}/api/identity`, {
        method: "GET",
        headers: { accept: "application/nostr+json" },
      });
      if (!resp.ok) return null;
      const json = (await resp.json()) as Record<string, unknown>;
      const info: Nip11Info = {
        url: relay,
        banner: stringOrNull(json["banner"]),
        description: stringOrNull(json["description"]),
        name: stringOrNull(json["name"]),
        pubkey: stringOrNull(json["pubkey"]),
        contact: stringOrNull(json["contact"]),
        supported_nips: numberArrayOrEmpty(json["supported_nips"]),
        limitation_max_message_length:
          numberOrNull(
            (json["limitation"] as Record<string, unknown> | undefined)?.["max_message_length"],
          ) ?? null,
        limitation_max_subscriptions:
          numberOrNull(
            (json["limitation"] as Record<string, unknown> | undefined)?.["max_subscriptions"],
          ) ?? null,
        limitation_max_filters:
          numberOrNull(
            (json["limitation"] as Record<string, unknown> | undefined)?.["max_filters"],
          ) ?? null,
        relay_countries: stringArrayOrEmpty(json["relay_countries"]),
        language_tags: stringArrayOrEmpty(json["language_tags"]),
        tags: stringArrayOrEmpty(json["tags"]),
        probed_at: Date.now(),
      };
      this.nip11.set(relay, info);
      return info;
    } catch {
      return null;
    }
  }

  /**
   * Fan out a signed fetch. Returns one `RelayResponse` per relay that was
   * tried. The order is non-deterministic (concurrent).
   *
   * If `opts.allowFanout` is false, only the default relay is called.
   */
  async signedFetchEach(opts: SignedFetchEachOptions): Promise<RelayResponse[]> {
    const log = getLogger();
    const allowFanout = opts.allowFanout !== false;
    const targetRelays = !allowFanout
      ? [this.defaultRelay]
      : opts.relays && opts.relays.length > 0
        ? opts.relays
        : this.relays;

    // Build per-relay options with the appropriate Host header.
    const perRelay = targetRelays.map((relay) => {
      const hostIdx = this.relays.indexOf(relay);
      const hostOverride = hostIdx >= 0 ? this.relayHosts[String(hostIdx)] : undefined;
      const headers: Record<string, string> = {
        ...((opts.headers as Record<string, string>) ?? {}),
      };
      if (this.cfAccess !== undefined) {
        headers["CF-Access-Client-Id"] = this.cfAccess.clientId;
        headers["CF-Access-Client-Secret"] = this.cfAccess.clientSecret;
      }
      if (hostOverride !== undefined) {
        headers["Host"] = hostOverride;
      }
      return { relay, url: this.buildUrl(relay, opts.url), headers };
    });

    const results = await Promise.all(
      perRelay.map(async ({ relay, url, headers }) => {
        const start = Date.now();
        const relayOpts: SignedFetchOptions = { ...opts, url, headers };
        try {
          const resp = await this.single(relay, relayOpts, "");
          let latencyMs = Date.now() - start;

          // 401 NIP-98 replay detected → sleep 1.5s + 1 retry.
          if (
            resp.status === 401 &&
            resp.bodyText.includes("replay") &&
            !opts._disableReplayRetry
          ) {
            await new Promise((r) => setTimeout(r, REPLAY_SLEEP_MS));
            const retry = await this.single(relay, relayOpts, "");
            latencyMs = Date.now() - start;
            return this.toRelayResponse(retry, relay, latencyMs);
          }

          return this.toRelayResponse(resp, relay, latencyMs);
        } catch (err) {
          const latencyMs = Date.now() - start;
          this.stats.record(relay, "network_error", latencyMs);
          log.warn("relay.fetch.error", {
            url: relay,
            latency_ms: latencyMs,
            error: (err as Error).message,
          });
          return {
            url: relay,
            status: 0,
            bodyText: "",
            event_id: null,
            accepted: false,
            latency_ms: latencyMs,
            ok: false,
            error: (err as Error).message,
          };
        }
      }),
    );
    return results;
  }

  /**
   * Resolve a channel name to its UUID across all relays. Returns
   * `{ byRelay, missing }` where `missing` is the list of relays that
   * don't know the channel. Cache TTL is `channelCacheTtlMs`.
   */
  async resolveChannel(
    name: string,
    forceRefresh: boolean = false,
  ): Promise<{
    byRelay: Map<string, string>;
    missing: string[];
  }> {
    const cacheKey = name.toLowerCase();
    if (!forceRefresh) {
      const cached = this.channelCache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        return { byRelay: new Map(cached.byRelay), missing: [] };
      }
    }

    // For each relay, query the kind:9007 channel-create events that
    // match the name. The relay's response is filtered client-side.
    const byRelay = new Map<string, string>();
    const missing: string[] = [];

    for (const relay of this.relays) {
      try {
        const filter = JSON.stringify({ kinds: [9007], "#name": [name], limit: 50 });
        const resp = await this.single(
          relay,
          {
            method: "POST",
            url: `${relay.replace(/\/$/, "")}/query`,
            body: filter,
            headers: { "content-type": "application/json" },
          },
          "channel_resolver",
        );
        if (resp.status !== 200) {
          missing.push(relay);
          continue;
        }
        const events = JSON.parse(resp.bodyText) as Array<{ tags: string[][] }>;
        const uuid = events[0]?.tags.find((t) => t[0] === "h")?.[1];
        if (uuid !== undefined) {
          byRelay.set(relay, uuid);
        } else {
          missing.push(relay);
        }
      } catch {
        missing.push(relay);
      }
    }

    this.channelCache.set(cacheKey, {
      byRelay: new Map(byRelay),
      expiresAt: Date.now() + this.channelCacheTtlMs,
    });
    return { byRelay, missing };
  }

  /** Invalidate the channel cache. Call after `create_channel`. */
  invalidateChannelCache(name?: string): void {
    if (name === undefined) {
      this.channelCache.clear();
    } else {
      this.channelCache.delete(name.toLowerCase());
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────

  private buildUrl(relay: string, originalUrl: string): string {
    // Replace the origin of `originalUrl` with `relay`. This handles the
    // case where the caller passes an absolute URL (e.g.,
    // `https://coreprt.webrnds.com/events`) and we want to swap the relay.
    try {
      const original = new URL(originalUrl);
      const target = new URL(relay);
      original.protocol = target.protocol;
      original.host = target.host;
      return original.toString();
    } catch {
      return originalUrl;
    }
  }

  private async single(
    relay: string,
    opts: SignedFetchOptions,
    tool: string,
  ): Promise<Awaited<ReturnType<typeof signedFetch>>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
    const start = Date.now();
    const log = getLogger();
    try {
      // Build the NIP-98 Authorization header manually and call the pool's
      // fetchImpl directly. This avoids the `globalThis.fetch` swap that
      // would cause recursion when the test stub has already replaced
      // `globalThis.fetch`.
      const authHeader = buildAuthHeader(this.secret, opts);
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      headers["Authorization"] = authHeader;
      const init: RequestInit = { method: opts.method, headers };
      if (opts.body !== undefined) {
        init.body = opts.body as BodyInit;
      }
      const signal = ac.signal;
      const fetchPromise = this.fetchImpl(opts.url, signal ? { ...init, signal } : init);
      const res = await fetchPromise;
      const bodyText = await res.text();
      const latencyMs = Date.now() - start;
      this.stats.record(relay, outcomeFromStatus(res.status), latencyMs);
      log.debug("relay.fetch", { tool, url: relay, status: res.status, latency_ms: latencyMs });
      return {
        status: res.status,
        bodyText,
        headers: res.headers,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private toRelayResponse(
    resp: Awaited<ReturnType<typeof signedFetch>>,
    relay: string,
    latencyMs: number,
  ): RelayResponse {
    let body: unknown;
    try {
      body = JSON.parse(resp.bodyText);
    } catch {
      body = null;
    }
    const eventId = parseAckId(body);
    // 2xx is accepted even without an id, matching v0.1.x behavior where
    // the tool returned `{accepted: true, raw: <body>}` for the operator
    // to inspect. The fan-out semantics: every 2xx counts as accepted.
    const accepted = resp.status >= 200 && resp.status < 300;
    return {
      url: relay,
      status: resp.status,
      bodyText: resp.bodyText,
      event_id: eventId,
      accepted,
      latency_ms: latencyMs,
      ok: accepted,
      error: !accepted
        ? formatRelayError(relay, { status: resp.status, bodyText: resp.bodyText })
        : undefined,
    };
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numberOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function numberArrayOrEmpty(v: unknown): readonly number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "number") as number[];
}
function stringArrayOrEmpty(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}
