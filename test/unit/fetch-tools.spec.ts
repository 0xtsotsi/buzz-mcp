/**
 * Unit tests for buzz_fetch_events and buzz_search.
 *
 * Both POST a NIP-01 filter to `/query` and return the raw event array. The
 * search tool tries the `search` field first, and falls back to a
 * client-side `content.includes` filter when the relay 4xx's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  registerFetchEventsTool,
  registerSearchTool,
} from "../../src/tools/fetch.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const RELAY = "https://relay.test";

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function makeFetchSpy(
  impl: (url: string, init: RequestInit) => Promise<Response> | Response,
) {
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

type RegisterFn = (
  server: McpServer,
  secret: typeof SECRET,
  relay: string,
) => void;

async function makeServerAndClient(register: RegisterFn) {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: {}, instructions: "test" },
  );
  register(server, SECRET, RELAY);
  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: {} },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { server, client };
}

function parseText(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text",
  )!.text;
  return JSON.parse(text);
}

describe("buzz_fetch_events", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a filter to /query and returns the raw events", async () => {
    const event = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1700000000,
      kind: 1,
      tags: [["t", "x"]],
      content: "hello",
      sig: "c".repeat(128),
    };
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify([event]), { status: 200 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerFetchEventsTool);
    const result = await client.callTool({
      name: "buzz_fetch_events",
      arguments: { filter: { kinds: [1], limit: 10 } },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/query`);
    expect(call.init.method).toBe("POST");
    const auth =
      call.init.headers["authorization"] ?? call.init.headers["Authorization"];
    expect(auth).toMatch(/^Nostr /);
    const body = JSON.parse(call.init.body);
    expect(body).toEqual({ kinds: [1], limit: 10 });

    const parsed = parseText(result) as { events: Array<{ id: string }> };
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].id).toBe("a".repeat(64));
    await client.close();
  });

  it("defaults the limit to 50 when not provided", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify([]), { status: 200 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerFetchEventsTool);
    await client.callTool({
      name: "buzz_fetch_events",
      arguments: { filter: { kinds: [1] } },
    });
    const body = JSON.parse(fetchSpy.calls[0].init.body);
    expect(body.limit).toBe(50);
    await client.close();
  });

  it("surfaces a 4xx as an error", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response("bad", { status: 500 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerFetchEventsTool);
    const result = await client.callTool({
      name: "buzz_fetch_events",
      arguments: { filter: {} },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 500/);
    await client.close();
  });
});

describe("buzz_search", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("forwards the search field to the relay and reports relay-side search mode", async () => {
    const event = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "hello world",
      sig: "c".repeat(128),
    };
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify([event]), { status: 200 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerSearchTool);
    const result = await client.callTool({
      name: "buzz_search",
      arguments: { search: "hello", filter: { kinds: [1] } },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const body = JSON.parse(fetchSpy.calls[0].init.body);
    expect(body.search).toBe("hello");
    expect(body.kinds).toEqual([1]);

    const parsed = parseText(result) as {
      events: unknown[];
      search_mode: "relay" | "client-side";
    };
    expect(parsed.search_mode).toBe("relay");
    expect(parsed.events).toHaveLength(1);
    await client.close();
  });

  it("falls back to client-side filtering when the relay 4xx's on the search field", async () => {
    const matching = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 1,
      kind: 1,
      tags: [],
      content: "hello world",
      sig: "c".repeat(128),
    };
    const nonMatching = {
      ...matching,
      id: "d".repeat(64),
      content: "goodbye world",
    };

    fetchSpy = makeFetchSpy(async (url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.search !== undefined) {
        return new Response("unknown search field", { status: 400 });
      }
      return new Response(JSON.stringify([matching, nonMatching]), { status: 200 });
    });
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerSearchTool);
    const result = await client.callTool({
      name: "buzz_search",
      arguments: { search: "hello" },
    });

    expect(fetchSpy.calls).toHaveLength(2);
    const fallbackBody = JSON.parse(fetchSpy.calls[1].init.body);
    expect(fallbackBody.search).toBeUndefined();

    const parsed = parseText(result) as {
      events: Array<{ content: string }>;
      search_mode: string;
    };
    expect(parsed.search_mode).toBe("client-side");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].content).toBe("hello world");
    await client.close();
  });
});