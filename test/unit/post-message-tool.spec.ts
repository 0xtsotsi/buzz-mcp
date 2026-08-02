/**
 * Unit tests for the buzz_post_message tool using a stubbed global fetch.
 * Avoids any network or local-relay dependency.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { RelayPool } from "../../src/relay/pool.js";
import { StatsStore } from "../../src/relay/stats.js";
import { createLogger } from "../../src/util/log.js";

function makePool(secret: string, relay: string): RelayPool {
  const stats = new StatsStore(createLogger({ level: "error" }));
  return new RelayPool({
    relays: [relay],
    defaultRelay: relay,
    relayHosts: {},
    secret: secret as never,
    stats,
    channelCacheTtlMs: 5 * 60 * 1000,
    fetchImpl: globalThis.fetch as typeof fetch,
  });
}

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPostMessageTool } from "../../src/tools/messages.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const RELAY = "https://relay.test";

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function makeFetchSpy(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
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

async function makeServerAndClient(secret: string, relay: string) {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: {}, instructions: "test" },
  );
  registerPostMessageTool(
    server,
    secret as never,
    relay,
    undefined,
    { mode: "mutate" },
    undefined,
    makePool(SECRET, RELAY),
  );
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { server, client };
}

describe("buzz_post_message tool", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${RELAY} is a placeholder, not a template.
  it("POSTs to ${RELAY}/events with a NIP-98 Authorization header", async () => {
    const ack = { ok: true, id: "a".repeat(64) };
    fetchSpy = makeFetchSpy(async () => new Response(JSON.stringify(ack), { status: 202 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(SECRET, RELAY);
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/events`);
    expect(call.init.method).toBe("POST");
    const authHeader = call.init.headers["authorization"] ?? call.init.headers["Authorization"];
    expect(authHeader).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
    expect(call.init.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(9);
    expect(body.content).toBe("hi");
    expect(body.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sig).toMatch(/^[0-9a-f]{128}$/);

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.event_id).toBe("a".repeat(64));
    expect(parsed.accepted).toBe(true);
    expect(parsed.channel).toBe("general");

    await client.close();
  });

  it("strips a leading '#' from the channel", async () => {
    const ack = { event_id: "b".repeat(64) };
    fetchSpy = makeFetchSpy(async () => new Response(JSON.stringify(ack), { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(SECRET, RELAY);
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "#general", content: "hi" },
    });
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.channel).toBe("general");

    await client.close();
  });

  it("rejects content that exceeds the 32KB byte cap", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(SECRET, RELAY);
    const big = "x".repeat(33 * 1024);
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: big },
    });
    expect(result.isError).toBe(true);
    expect(fetchSpy.calls).toHaveLength(0); // no HTTP call was made
    await client.close();
  });

  it("surfaces a non-2xx response as a tool error", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("rate limited", { status: 429 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(SECRET, RELAY);
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 429/);
    await client.close();
  });

  it("falls back to raw body when the relay ack has no event id", async () => {
    fetchSpy = makeFetchSpy(async () => new Response('{"weird":"shape"}', { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(SECRET, RELAY);
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.accepted).toBe(true);
    expect(parsed.raw).toEqual({ weird: "shape" });
    await client.close();
  });

  it("rejects emoji content that exceeds the 32KB byte cap (not char cap)", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;
    const { client } = await makeServerAndClient(SECRET, RELAY);

    // Each "🚀" is 4 UTF-8 bytes. 10000 of them = 40000 bytes, which exceeds
    // the 32KB cap even though the .length is only 10000.
    const content = "🚀".repeat(10_000);
    expect(content.length).toBeLessThan(32 * 1024);
    const bytes = new TextEncoder().encode(content).byteLength;
    expect(bytes).toBeGreaterThan(32 * 1024);
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content },
    });
    expect(result.isError).toBe(true);
    const resultText = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    )!.text!;
    expect(resultText).toMatch(/exceeds \d+-byte cap/);

    await client.close();
  });
});
