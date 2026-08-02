/**
 * Integration tests for the `buzz_get_stats` MCP tool.
 *
 * Phase 2 of the multi-relay plan. The tool exposes the per-relay stats
 * that the relay client has recorded. Tests:
 *   - Boots `createServer()` and triggers a real signed fetch.
 *   - Calls `buzz_get_stats` and validates the response shape.
 *   - Tests the `relay` filter arg.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/index.js";

const SECRET = "a".repeat(64);
const RELAY = "https://relay.test";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env["BUZZ_PRIVATE_KEY"] = SECRET;
  process.env["BUZZ_RELAY_URL"] = RELAY;
  process.env["BUZZ_MCP_MODE"] = "mutate";
  delete process.env["CF_ACCESS_CLIENT_ID"];
  delete process.env["CF_ACCESS_CLIENT_SECRET"];
  // Quiet logs in tests.
  process.env["BUZZ_MCP_LOG"] = "error";
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function makeFetchSpy(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init: init ?? {} });
    return impl(u, init ?? {});
  });
  return { spy, calls };
}

async function bootServer() {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { server, client };
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const text = (result.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text",
  );
  if (text === undefined) throw new Error("no text content");
  return text.text;
}

describe("buzz_get_stats — end-to-end", () => {
  it("returns an empty snapshot before any calls", async () => {
    const { client } = await bootServer();
    const result = await client.callTool({ name: "buzz_get_stats", arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(getText(result));
    expect(body.stats).toEqual([]);
    expect(typeof body.snapshot_at).toBe("string");
    await client.close();
  });

  it("records a successful post_message call", async () => {
    const { spy } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    const result = await client.callTool({ name: "buzz_get_stats", arguments: {} });
    const body = JSON.parse(getText(result));
    expect(body.stats).toHaveLength(1);
    expect(body.stats[0]).toMatchObject({
      url: RELAY,
      calls_total: 1,
      success: 1,
    });
    expect(body.stats[0].latency_p50_ms).toBeGreaterThanOrEqual(0);
    await client.close();
  });

  it("records a 401 response in the rejected_401 bucket", async () => {
    const { spy } = makeFetchSpy(async () => new Response("unauthorized", { status: 401 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    const result = await client.callTool({ name: "buzz_get_stats", arguments: {} });
    const body = JSON.parse(getText(result));
    expect(body.stats[0]).toMatchObject({
      calls_total: 1,
      success: 0,
      rejected_401: 1,
    });
    await client.close();
  });

  it("filters by relay URL when the `relay` arg is set", async () => {
    const { spy } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    const known = await client.callTool({
      name: "buzz_get_stats",
      arguments: { relay: RELAY },
    });
    const knownBody = JSON.parse(getText(known));
    expect(knownBody.stats).toHaveLength(1);

    const unknown = await client.callTool({
      name: "buzz_get_stats",
      arguments: { relay: "https://other-relay.test" },
    });
    const unknownBody = JSON.parse(getText(unknown));
    expect(unknownBody.stats).toEqual([]);
    await client.close();
  });

  it("is read-only (not gated by mutate-with-confirm)", async () => {
    process.env["BUZZ_MCP_MODE"] = "mutate-with-confirm";
    const { spy } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({ name: "buzz_get_stats", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it("is read-only (not gated by read-only)", async () => {
    process.env["BUZZ_MCP_MODE"] = "read-only";
    const { spy } = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({ name: "buzz_get_stats", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});
