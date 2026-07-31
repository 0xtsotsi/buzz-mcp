/**
 * Unit tests for buzz_post_thread_summary (kind:39005).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerPostThreadSummaryTool } from "../../src/tools/summaries.js";

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

async function makeServerAndClient() {
  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: {}, instructions: "test" },
  );
  registerPostThreadSummaryTool(server, SECRET, RELAY);
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

describe("buzz_post_thread_summary", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a kind:39005 event with a root e-tag and the summary in content", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_post_thread_summary",
      arguments: {
        rootEventId: "1".repeat(64),
        summary: "TL;DR: shipped.",
      },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/events`);
    const auth =
      call.init.headers["authorization"] ?? call.init.headers["Authorization"];
    expect(auth).toMatch(/^Nostr /);

    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(39005);
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(body.content).toBe("TL;DR: shipped.");
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "e")).toEqual([
      "e",
      "1".repeat(64),
      "",
      "root",
    ]);

    const parsed = parseText(result) as {
      event_id: string;
      accepted: boolean;
      thread: string;
    };
    expect(parsed.accepted).toBe(true);
    expect(parsed.thread).toBe("1".repeat(64));
    await client.close();
  });

  it("surfaces a 4xx as a tool error", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response("nope", { status: 500 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_post_thread_summary",
      arguments: { rootEventId: "1".repeat(64), summary: "x" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 500/);
    await client.close();
  });



  it("rejects multibyte summary that exceeds 32KB byte cap", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;
    const { client } = await makeServerAndClient();

    // Each "🚀" is 4 UTF-8 bytes. 10000 of them = 40KB, which exceeds the
    // 32KB cap even though .length is well under 32K.
    const summary = "🚀".repeat(10_000);
    const result = await client.callTool({
      name: "buzz_post_thread_summary",
      arguments: { rootEventId: "a".repeat(64), summary },
    });
    expect(result.isError).toBe(true);
    const resultText = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    )!.text!;
    expect(resultText).toMatch(/exceeds \d+-byte cap/);
    expect(fetchSpy.calls).toHaveLength(0); // no HTTP call — rejected pre-flight

    await client.close();
  });
});
