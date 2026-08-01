/**
 * Unit tests for the three subscription MCP tools.
 *
 * Each test wires up a stub `WebSocket` (`FakeWS`) before the
 * {@link SubscriptionManager} opens its socket. The fake:
 *
 *   - records every `send(json)` call (used to assert REQ / CLOSE / AUTH);
 *   - exposes `_triggerOpen`, `_triggerMessage`, and `_triggerAuthChallenge`
 *     so the test can drive the FSM without sockets.
 *
 * The NIP-42 handshake path is covered by the AUTH-challenge test;
 * the no-challenge path is covered by the subscribe + poll tests (they
 * never fire an AUTH challenge, so the manager resolves start() once the
 * `authTimeoutMs` window elapses — the manager defaults are tuned short
 * enough for the test suite).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SubscriptionEvent, SubscriptionManager } from "../../src/relay/subscription.js";
import {
  registerPollTool,
  registerSubscribeTool,
  registerUnsubscribeTool,
} from "../../src/tools/subscribe.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const RELAY = "wss://relay.test";
const AUTH_TIMEOUT_MS = 50;

// ─── FakeWS ────────────────────────────────────────────────────────────────

/**
 * Minimal stand-in for the native `WebSocket` used by `SubscriptionManager`.
 * Stores every `send` call and exposes trigger helpers for the tests to
 * fire `open`, `message`, and `close` events exactly when the manager
 * expects them.
 */
class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static lastInstance: FakeWS | null = null;

  readonly url: string;
  readyState: number = FakeWS.CONNECTING;
  sentMessages: string[] = [];

  // The manager reads `ws.OPEN` directly. Expose it as an instance field too.
  readonly OPEN = FakeWS.OPEN;
  readonly CLOSED = FakeWS.CLOSED;
  readonly CLOSING = FakeWS.CLOSING;
  readonly CONNECTING = FakeWS.CONNECTING;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWS.lastInstance = this;
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    // The manager only listens for `close` in error paths; tests do not
    // exercise that path, so no DOM `CloseEvent` is required.
    void code;
    void reason;
  }

  /** Fire the `open` event. */
  _triggerOpen(): void {
    if (this.onopen === null) {
      throw new Error("FakeWS._triggerOpen: onopen handler not installed");
    }
    this.readyState = FakeWS.OPEN;
    this.onopen(new Event("open"));
  }

  /** Fire a `message` event with the given raw text payload. */
  _triggerMessage(data: string): void {
    if (this.onmessage === null) {
      throw new Error("FakeWS._triggerMessage: onmessage handler not installed");
    }
    const ev = new MessageEvent("message", { data });
    this.onmessage(ev);
  }

  /** Fire a `["AUTH", challenge]` frame. */
  _triggerAuthChallenge(challenge: string): void {
    this._triggerMessage(JSON.stringify(["AUTH", challenge]));
  }

  /** Fire a `["EVENT", subId, event]` frame. */
  _triggerEvent(subId: string, event: SubscriptionEvent): void {
    this._triggerMessage(JSON.stringify(["EVENT", subId, event]));
  }

  /** Fire a `["CLOSED", subId]` frame. */
  _triggerClosed(subId: string): void {
    this._triggerMessage(JSON.stringify(["CLOSED", subId]));
  }

  get lastSent(): string | undefined {
    return this.sentMessages[this.sentMessages.length - 1];
  }

  lastSentParsed(): unknown {
    const last = this.lastSent;
    if (last === undefined) throw new Error("FakeWS.lastSentParsed: no message sent");
    return JSON.parse(last);
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

interface FetchSpy {
  spy: ReturnType<typeof vi.fn>;
  calls: Array<{
    url: string;
    init: { method: string; headers: Record<string, string>; body: string };
  }>;
}

function makeFetchSpy(
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
): FetchSpy {
  const calls: FetchSpy["calls"] = [];
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        Object.assign(headers, init.headers);
      }
    }
    calls.push({
      url: u,
      init: {
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      },
    });
    return impl(u, init ?? {});
  });
  return { spy, calls };
}

type RegisterFn = (server: McpServer, subs: SubscriptionManager) => void;

async function makeServerAndClient(
  register: RegisterFn,
  subs: SubscriptionManager,
): Promise<{ server: McpServer; client: Client }> {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: {}, instructions: "test" },
  );
  register(server, subs);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { server, client };
}

function newManager(): SubscriptionManager {
  return new SubscriptionManager(SECRET, RELAY, {
    wsImpl: FakeWS as unknown as typeof WebSocket,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
}

function parseText(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text",
  )!.text;
  return JSON.parse(text);
}

function newEvent(id: string, content: string): SubscriptionEvent {
  return {
    id,
    pubkey: "b".repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content,
    sig: "c".repeat(128),
  };
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("buzz_subscribe", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // NIP-42 auth opens up no other endpoints in this PR, but be defensive:
    // any unintended fetch would surface as a missing-spied fetch error.
    const { spy } = makeFetchSpy(async () => new Response("not used", { status: 599 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    FakeWS.lastInstance = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("opens a REQ against the shared WS, responds to AUTH if challenged, and returns a 32-hex sub_id", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerSubscribeTool, subs);

    // Issue the tool call BEFORE the WS opens — `subscribe()` will lazy-start
    // the connection.
    const subscribePromise = client.callTool({
      name: "buzz_subscribe",
      arguments: { kinds: [1], limit: 7 },
    });

    // Let the SubscribeManager instantiate the FakeWS. We resolve the tool
    // after driving the FSM.
    await new Promise<void>((r) => setImmediate(() => r()));
    const ws = FakeWS.lastInstance;
    expect(ws).not.toBeNull();
    expect(ws!.url).toBe(RELAY);

    // 1) Drive `open`. The manager starts an `authTimeoutMs` timer.
    ws!._triggerOpen();

    // 2) Issue an AUTH challenge. The manager should sign a kind:22242 event
    // and send it as `["AUTH", event]`.
    ws!._triggerAuthChallenge("challenge-abc-123");

    const result = await subscribePromise;
    expect(result.isError).toBeFalsy();

    // Look for the AUTH reply.
    const authSent = ws!.sentMessages
      .map((s) => JSON.parse(s) as unknown[])
      .find(
        (m) =>
          Array.isArray(m) &&
          m[0] === "AUTH" &&
          m.length >= 2 &&
          typeof (m[1] as { kind?: unknown }).kind === "number",
      );
    expect(authSent, "expected an [" + '"AUTH", <signed event>]: reply').toBeDefined();
    const authFrame = authSent as [string, { kind: number; tags: string[][] }];
    expect(authFrame[1].kind).toBe(22242);
    const tags = authFrame[1].tags;
    expect(tags).toContainEqual(["relay", RELAY]);
    expect(tags).toContainEqual(["challenge", "challenge-abc-123"]);

    // Also expect a REQ after the AUTH handshake.
    const reqSent = ws!.sentMessages
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => Array.isArray(m) && m[0] === "REQ");
    expect(reqSent).toBeDefined();
    const reqFrame = reqSent as [string, string, { kinds?: number[]; limit?: number }];
    expect(reqFrame[0]).toBe("REQ");
    expect(reqFrame[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(reqFrame[2]).toEqual({ kinds: [1], limit: 7 });

    // The sub_id returned by the tool must match the one in REQ.
    const parsed = parseText(result) as {
      sub_id: string;
      open: boolean;
      filter: { kinds: number[]; limit: number };
    };
    expect(parsed.sub_id).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.sub_id).toBe(reqFrame[1]);
    expect(parsed.open).toBe(true);
    expect(parsed.filter).toEqual({ kinds: [1], limit: 7 });

    await client.close();
  });

  it("defaults the filter to {kinds: [1]} when no fields are provided", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerSubscribeTool, subs);

    const subPromise = client.callTool({
      name: "buzz_subscribe",
      arguments: {},
    });
    await new Promise<void>((r) => setImmediate(() => r()));
    const ws = FakeWS.lastInstance!;
    ws._triggerOpen();
    // No AUTH challenge — the authTimeoutMs window elapses, then REQ is sent.
    await new Promise<void>((r) => setTimeout(r, AUTH_TIMEOUT_MS + 10));
    // Once start() resolves, the manager sends the REQ. We may need an extra
    // tick for any chained microtasks.
    await new Promise<void>((r) => setImmediate(() => r()));

    const result = await subPromise;
    expect(result.isError).toBeFalsy();
    const reqSent = ws.sentMessages
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => Array.isArray(m) && m[0] === "REQ");
    expect(reqSent).toBeDefined();
    const reqFrame = reqSent as [string, string, { kinds?: number[] }];
    expect(reqFrame[2].kinds).toEqual([1]);

    await client.close();
  });
});

describe("buzz_unsubscribe", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    FakeWS.lastInstance = null;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends [" + '"CLOSE", subId]' + " and removes the sub from the manager", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerUnsubscribeTool, subs);

    // Seed the manager with a known sub by performing an actual subscribe.
    // We re-use the same FakeWS driver path to keep behaviour realistic.
    const subPromise = subs.subscribe({ kinds: [1], limit: 5 });
    await new Promise<void>((r) => setImmediate(() => r()));
    const ws = FakeWS.lastInstance!;
    ws._triggerOpen();
    await new Promise<void>((r) => setTimeout(r, AUTH_TIMEOUT_MS + 10));
    const sub_id = await subPromise;

    expect(subs.listSubs()).toContain(sub_id);

    const result = await client.callTool({
      name: "buzz_unsubscribe",
      arguments: { subId: sub_id },
    });
    expect(result.isError).toBeFalsy();

    // CLOSE was sent on the WS for the same sub_id.
    const closeSent = ws.sentMessages
      .map((s) => JSON.parse(s) as unknown[])
      .find((m) => Array.isArray(m) && m[0] === "CLOSE" && m.length >= 2 && m[1] === sub_id);
    expect(closeSent).toBeDefined();

    // Sub is removed locally.
    expect(subs.listSubs()).not.toContain(sub_id);

    const parsed = parseText(result) as { sub_id: string; closed: boolean };
    expect(parsed.sub_id).toBe(sub_id);
    expect(parsed.closed).toBe(true);

    await client.close();
  });

  it("is a no-op (closed: false) for an unknown sub_id", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerUnsubscribeTool, subs);
    const result = await client.callTool({
      name: "buzz_unsubscribe",
      arguments: { subId: "f".repeat(32) },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result) as { sub_id: string; closed: boolean };
    expect(parsed.closed).toBe(false);
    await client.close();
  });
});

describe("buzz_poll", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    FakeWS.lastInstance = null;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("drains buffered events in FIFO order, returns remaining count, and a second poll returns 0", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerPollTool, subs);

    // Drive start() + subscribe() programmatically, then push events.
    const subPromise = subs.subscribe({ kinds: [1], limit: 5 });
    await new Promise<void>((r) => setImmediate(() => r()));
    const ws = FakeWS.lastInstance!;
    ws._triggerOpen();
    await new Promise<void>((r) => setTimeout(r, AUTH_TIMEOUT_MS + 10));
    const sub_id = await subPromise;

    // Push 3 events into the buffer; they must come back in order.
    ws._triggerEvent(sub_id, newEvent("1".repeat(64), "first"));
    ws._triggerEvent(sub_id, newEvent("2".repeat(64), "second"));
    ws._triggerEvent(sub_id, newEvent("3".repeat(64), "third"));

    const first = await client.callTool({
      name: "buzz_poll",
      arguments: { subId: sub_id, max: 50 },
    });
    expect(first.isError).toBeFalsy();
    const parsedFirst = parseText(first) as {
      sub_id: string;
      events: Array<{ id: string; content: string }>;
      remaining: number;
    };
    expect(parsedFirst.sub_id).toBe(sub_id);
    expect(parsedFirst.events).toHaveLength(3);
    expect(parsedFirst.events.map((e) => e.content)).toEqual(["first", "second", "third"]);
    expect(parsedFirst.events[0].id).toBe("1".repeat(64));
    expect(parsedFirst.remaining).toBe(0);

    // A second poll of the same sub drains nothing.
    const second = await client.callTool({
      name: "buzz_poll",
      arguments: { subId: sub_id, max: 50 },
    });
    const parsedSecond = parseText(second) as {
      events: unknown[];
      remaining: number;
    };
    expect(parsedSecond.events).toEqual([]);
    expect(parsedSecond.remaining).toBe(0);

    await client.close();
  });

  it("respects `max` and reports the correct `remaining` count", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerPollTool, subs);

    const subPromise = subs.subscribe({ kinds: [1], limit: 10 });
    await new Promise<void>((r) => setImmediate(() => r()));
    const ws = FakeWS.lastInstance!;
    ws._triggerOpen();
    await new Promise<void>((r) => setTimeout(r, AUTH_TIMEOUT_MS + 10));
    const sub_id = await subPromise;

    for (let i = 0; i < 5; i++) {
      ws._triggerEvent(sub_id, newEvent(`${i}`.padStart(64, "0"), `msg-${i}`));
    }

    const result = await client.callTool({
      name: "buzz_poll",
      arguments: { subId: sub_id, max: 2 },
    });
    const parsed = parseText(result) as {
      events: Array<{ content: string }>;
      remaining: number;
    };
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events.map((e) => e.content)).toEqual(["msg-0", "msg-1"]);
    expect(parsed.remaining).toBe(3);

    await client.close();
  });

  it("returns an empty events array for an unknown sub_id", async () => {
    const subs = newManager();
    const { client } = await makeServerAndClient(registerPollTool, subs);
    const result = await client.callTool({
      name: "buzz_poll",
      arguments: { subId: "f".repeat(32) },
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseText(result) as {
      sub_id: string;
      events: unknown[];
      remaining: number;
    };
    expect(parsed.events).toEqual([]);
    expect(parsed.remaining).toBe(0);
    expect(parsed.sub_id).toBe("f".repeat(32));
    await client.close();
  });
});
