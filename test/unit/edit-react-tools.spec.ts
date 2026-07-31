/**
 * Unit tests for the two PR-#4 message tools added to src/tools/messages.ts:
 *   buzz_edit_message (kind:40003) and buzz_react (kind:7).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerEditMessageTool, registerReactTool } from "../../src/tools/messages.js";

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

type RegisterFn = (server: McpServer, secret: typeof SECRET, relay: string) => void;

async function makeServerAndClient(register: RegisterFn) {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: {}, instructions: "test" },
  );
  register(server, SECRET, RELAY);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
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

describe("buzz_edit_message", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a kind:40003 edit event with the original event id as an e-tag", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerEditMessageTool);
    const result = await client.callTool({
      name: "buzz_edit_message",
      arguments: {
        eventId: "1".repeat(64),
        content: "edited body",
        originalKind: 9,
      },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/events`);
    const auth = call.init.headers["authorization"] ?? call.init.headers["Authorization"];
    expect(auth).toMatch(/^Nostr /);

    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(40003);
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sig).toMatch(/^[0-9a-f]{128}$/);
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "e")).toEqual(["e", "1".repeat(64), "", "edit"]);
    expect(body.content).toBe("edited body");

    const parsed = parseText(result) as {
      event_id: string;
      accepted: boolean;
      target: string;
    };
    expect(parsed.event_id).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.accepted).toBe(true);
    expect(parsed.target).toBe("1".repeat(64));
    await client.close();
  });

  it("surfaces a 4xx response as a tool error", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("nope", { status: 422 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerEditMessageTool);
    const result = await client.callTool({
      name: "buzz_edit_message",
      arguments: { eventId: "1".repeat(64), content: "x", originalKind: 1 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 422/);
    await client.close();
  });
});

describe("buzz_react", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a kind:7 reaction event with the target event id and emoji", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerReactTool);
    const result = await client.callTool({
      name: "buzz_react",
      arguments: { eventId: "2".repeat(64), emoji: "🔥" },
    });

    const call = fetchSpy.calls[0];
    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(7);
    expect(body.content).toBe("🔥");
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "e")).toEqual(["e", "2".repeat(64)]);
    expect(tags.find((t) => t[0] === "content")).toEqual(["content", "🔥"]);

    const parsed = parseText(result) as {
      event_id: string;
      accepted: boolean;
      target: string;
      emoji: string;
    };
    expect(parsed.accepted).toBe(true);
    expect(parsed.target).toBe("2".repeat(64));
    expect(parsed.emoji).toBe("🔥");
    await client.close();
  });

  it("rejects emoji longer than 16 chars at the Zod layer", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerReactTool);
    const result = await client.callTool({
      name: "buzz_react",
      arguments: { eventId: "3".repeat(64), emoji: "a".repeat(17) },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
