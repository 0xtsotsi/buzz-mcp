/**
 * WebSocket subscription manager.
 *
 * One process = one agent identity = one WS connection. The
 * {@link SubscriptionManager} opens (lazily, on first subscribe) a single
 * NIP-01 WebSocket connection to the relay, completes the NIP-42 `AUTH`
 * handshake if challenged, and buffers every `EVENT` frame into a per-sub
 * FIFO ring buffer keyed by `sub_id`.
 *
 * Subscriptions are pull-only — the MCP tools `buzz_subscribe`,
 * `buzz_unsubscribe`, and `buzz_poll` are the public surface. There is NO
 * push / no `notifications/*` streaming: events are drained via `poll()`.
 *
 * Pure module: depends on the local signer (`signEvent`) for NIP-42 auth, the
 * optional `wsImpl` is injected so tests can drive the FSM without sockets.
 *
 * Reference:
 *   - NIP-01 (basic protocol): https://github.com/nostr-protocol/nips/blob/master/01.md
 *   - NIP-42 (auth):          https://github.com/nostr-protocol/nips/blob/master/42.md
 */
import { type NsecOrHex, signEvent } from "./signer.js";

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * The subset of NIP-01 filter fields this server emits to the relay. The
 * wide index signature accepts any `#<letter>` tag filter (e.g. `#p`,
 * `#d`) without re-registering a new filter shape.
 */
export type SubscriptionFilter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  "#e"?: string[];
  "#t"?: string[];
  search?: string;
  [k: `#${string}`]: string[] | undefined;
};

/**
 * A fully-decoded Nostr event as received from the relay. Identical in shape
 * to `NostrEvent` in `relay/signer.ts`; copied here so this module stays
 * standalone and so the MCP tool surface can import it without dragging in
 * signer internals.
 */
export type SubscriptionEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

/** Internal record held per subscription. */
type SubState = {
  filter: SubscriptionFilter;
  buffer: SubscriptionEvent[];
};

/** Options bag for the manager constructor. */
export type SubscriptionManagerOptions = {
  /** Max events per sub ring buffer. Oldest dropped FIFO. Default 1000. */
  maxBufferSize?: number;
  /** Override the WebSocket constructor (used by tests). */
  wsImpl?: typeof WebSocket;
  /** How long to wait for an AUTH challenge before assuming none. Default 5000ms. */
  authTimeoutMs?: number;
};

// ─── SubscriptionManager ───────────────────────────────────────────────────

/**
 * Singleton-per-process WebSocket subscription manager.
 *
 * Lazy: nothing happens until `start()` (or `subscribe()`) is called. After
 * the WS is open and any NIP-42 `AUTH` challenge has been answered, the
 * caller may issue `["REQ", sub_id, filter]` via `subscribe()` and drain
 * buffered `["EVENT", sub_id, event]` frames via `poll()`.
 */
export class SubscriptionManager {
  readonly #secret: NsecOrHex;
  readonly #relayUrl: string;
  readonly #maxBufferSize: number;
  readonly #wsImpl: typeof WebSocket;
  readonly #authTimeoutMs: number;

  #ws: WebSocket | null = null;
  #ready: boolean = false;
  #subs: Map<string, SubState> = new Map();

  constructor(secret: NsecOrHex, relayUrl: string, opts: SubscriptionManagerOptions = {}) {
    this.#secret = secret;
    this.#relayUrl = relayUrl.replace(/\/$/, "");
    this.#maxBufferSize = opts.maxBufferSize ?? 1000;
    // Node 22+ exposes `WebSocket` natively (undici). Tests inject a stub.
    this.#wsImpl = opts.wsImpl ?? globalThis.WebSocket;
    this.#authTimeoutMs = opts.authTimeoutMs ?? 5_000;
  }

  /**
   * Open the WS, complete the NIP-42 `AUTH` handshake if challenged.
   * Retries on transient errors with exponential backoff (max 3 attempts,
   * base 200ms → 400ms → 800ms).
   */
  async start(): Promise<void> {
    if (this.#ready) return;
    const baseMs = 200;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#openOnce();
        this.#ready = true;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await sleep(baseMs * 2 ** attempt);
        }
      }
    }
    throw new Error(
      `SubscriptionManager.start: gave up after 3 attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  /**
   * Open a `["REQ", sub_id, filter]` subscription. Lazily starts the WS.
   * Returns the `sub_id` (32 lowercase-hex chars; safe to use as a JS map key).
   */
  async subscribe(filter: SubscriptionFilter): Promise<string> {
    if (!this.#ready) {
      await this.start();
    }
    if (this.#ws === null) {
      throw new Error("SubscriptionManager.subscribe: WS is null after start()");
    }
    const subId = makeSubId();
    this.#subs.set(subId, { filter, buffer: [] });
    this.#ws.send(JSON.stringify(["REQ", subId, filter]));
    return subId;
  }

  /**
   * Send `["CLOSE", subId]` and drop the sub from the in-memory map.
   * No-op if the sub does not exist.
   */
  async unsubscribe(subId: string): Promise<void> {
    if (!this.#subs.has(subId)) return;
    this.#subs.delete(subId);
    if (this.#ws && this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(JSON.stringify(["CLOSE", subId]));
    }
  }

  /**
   * Drain up to `max` events from the sub's ring buffer (FIFO). Returns [] if
   * the sub does not exist or no events are buffered.
   */
  poll(subId: string, max: number = 50): SubscriptionEvent[] {
    const sub = this.#subs.get(subId);
    if (!sub) return [];
    const n = Math.max(0, Math.floor(max));
    if (n === 0) return [];
    return sub.buffer.splice(0, n);
  }

  /** Number of events still buffered for `subId`. 0 for unknown subs. */
  remaining(subId: string): number {
    return this.#subs.get(subId)?.buffer.length ?? 0;
  }

  /** Send `["CLOSE"]` for every active sub, drop them, close the WS. */
  async close(): Promise<void> {
    const ws = this.#ws;
    this.#subs.clear();
    this.#ready = false;
    if (ws && ws.readyState === ws.OPEN) {
      for (const subId of Array.from(this.#subs.keys())) {
        try {
          ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          /* ignore — connection may be tearing down */
        }
      }
      ws.close();
    }
    this.#ws = null;
  }

  /** Snapshot of active sub ids (for diagnostics / tools/list introspection). */
  listSubs(): string[] {
    return Array.from(this.#subs.keys());
  }

  /** Current relay URL the manager is configured against. */
  get relayUrl(): string {
    return this.#relayUrl;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /**
   * Open the WS once. Resolves once the socket is open AND either (a) an
   * `AUTH` challenge has been answered, or (b) `authTimeoutMs` elapses with
   * no challenge. Rejects on socket error / premature close.
   */
  #openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new this.#wsImpl(this.#relayUrl);
      let settled = false;
      const finish = (fn: () => void, timer: ReturnType<typeof setTimeout> | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        fn();
      };
      let authTimer: ReturnType<typeof setTimeout> | null = null;

      ws.onmessage = (ev: MessageEvent): void => {
        const msg = parseFrame(ev.data);
        if (msg === null) return;
        const tag = msg[0];
        if (tag === "AUTH" && typeof msg[1] === "string" && authTimer !== null) {
          // Got the challenge — respond with a signed kind:22242.
          const challenge = msg[1];
          try {
            const authEvent = signEvent(this.#secret, {
              kind: 22242,
              tags: [
                ["relay", this.#relayUrl],
                ["challenge", challenge],
              ],
              content: "",
            });
            ws.send(JSON.stringify(["AUTH", authEvent]));
            finish(resolve, authTimer);
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))), authTimer);
          }
          return;
        }
        // All other frames route through the buffer.
        this.#route(msg);
      };

      ws.onopen = (): void => {
        // Wait at most `authTimeoutMs` for an AUTH challenge. If none
        // arrives, the relay is OK without auth.
        authTimer = setTimeout(() => {
          finish(resolve, authTimer);
        }, this.#authTimeoutMs);
      };

      ws.onerror = (ev: Event): void => {
        const msg = (ev as ErrorEvent).message ?? `ws error (no message)`;
        finish(() => reject(new Error(`SubscriptionManager: ${msg}`)), authTimer);
      };

      ws.onclose = (ev: CloseEvent): void => {
        finish(
          () =>
            reject(
              new Error(`SubscriptionManager: ws closed (code=${ev.code} reason="${ev.reason}")`),
            ),
          authTimer,
        );
      };

      this.#ws = ws;
    });
  }

  /**
   * Route a non-AUTH frame. Recognises `EVENT` (push to the sub's buffer),
   * `CLOSED` (remove the sub locally), and silently ignores everything
   * else (`EOSE`, `NOTICE`, `OK`).
   */
  #route(msg: unknown[]): void {
    const tag = msg[0];
    if (tag === "EVENT") {
      const subId = msg[1];
      const event = msg[2];
      if (typeof subId !== "string") return;
      const sub = this.#subs.get(subId);
      if (!sub || !isSubscriptionEvent(event)) return;
      sub.buffer.push(event);
      // Trim the oldest if we exceeded the cap.
      if (sub.buffer.length > this.#maxBufferSize) {
        sub.buffer.splice(0, sub.buffer.length - this.#maxBufferSize);
      }
      return;
    }
    if (tag === "CLOSED" && typeof msg[1] === "string") {
      // The relay confirms a CLOSE — drop our local state too.
      this.#subs.delete(msg[1]);
      return;
    }
    // OK / EOSE / NOTICE / anything else: ignore.
  }
}

// ─── module-level helpers ──────────────────────────────────────────────────

/** crypto.randomUUID() returns 36 chars with dashes; strip → 32 hex chars. */
function makeSubId(): string {
  // Fall back to Math.random if `globalThis.crypto` is somehow missing; this
  // should be unreachable on Node ≥20 and on every modern browser.
  let hex: string;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    hex = globalThis.crypto.randomUUID().replace(/-/g, "");
  } else {
    hex = Math.random().toString(16).slice(2).padStart(32, "0").slice(-32);
  }
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    // Defensive: should be impossible given the inputs above.
    throw new Error(`makeSubId: produced non-hex id (${hex})`);
  }
  return hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a single WS frame `data` field into an array. Tolerates:
 *   - string data (the common case from undici),
 *   - ArrayBuffer / Uint8Array (from the `binaryType: "arraybuffer"` setting).
 * Returns `null` if the data cannot be parsed as a JSON array.
 */
function parseFrame(data: unknown): unknown[] | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(new Uint8Array(data));
  } else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } else {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

/** Narrow to the on-the-wire event shape. */
function isSubscriptionEvent(value: unknown): value is SubscriptionEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.pubkey === "string" &&
    typeof v.created_at === "number" &&
    typeof v.kind === "number" &&
    Array.isArray(v.tags) &&
    typeof v.content === "string" &&
    typeof v.sig === "string"
  );
}
