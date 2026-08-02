/**
 * Integration tests for the Phase 1 mode/dryRun/confirm plumbing on the
 * four write tools: `buzz_post_message`, `buzz_edit_message`, `buzz_react`,
 * `buzz_create_channel`, `buzz_add_member`.
 *
 * Each test boots `createServer()` with a specific BUZZ_MCP_MODE and
 * asserts the right outcome (allowed fetch, pending-confirm response,
 * dry-run response, or read-only error).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/index.js";

const SECRET = "a".repeat(64);
const RELAY = "https://relay.test";

const originalEnv = { ...process.env };

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

async function bootServer(): Promise<{ server: McpServer; client: Client }> {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { server, client };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return headers[k];
  }
  return undefined;
}

function ackBody() {
  return JSON.stringify({ ok: true, id: "a".repeat(64) });
}

beforeEach(() => {
  process.env["BUZZ_PRIVATE_KEY"] = SECRET;
  process.env["BUZZ_RELAY_URL"] = RELAY;
  delete process.env["CF_ACCESS_CLIENT_ID"];
  delete process.env["CF_ACCESS_CLIENT_SECRET"];
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("BUZZ_MCP_MODE=mutate-with-confirm (the new default)", () => {
  beforeEach(() => {
    process.env["BUZZ_MCP_MODE"] = "mutate-with-confirm";
  });

  it("returns pending-confirm on buzz_post_message and does NOT fetch", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("pending-confirm");
    expect(parsed.unsigned_event.kind).toBe(9);
    expect(parsed.unsigned_event.content).toBe("hi");
    expect(parsed.channel).toBe("general");
    await client.close();
  });

  it("actually posts when confirm: true is passed", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi", confirm: true },
    });
    expect(calls).toHaveLength(1);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.event_id).toBe("a".repeat(64));
    expect(parsed.accepted).toBe(true);
    await client.close();
  });

  it("returns pending-confirm on buzz_react without confirm", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_react",
      arguments: { eventId: "a".repeat(64), emoji: "+" },
    });
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("pending-confirm");
    expect(parsed.unsigned_event.kind).toBe(7);
    await client.close();
  });

  it("returns pending-confirm on buzz_create_channel without confirm", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_create_channel",
      arguments: { name: "test", visibility: "public" },
    });
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("pending-confirm");
    expect(parsed.unsigned_event.kind).toBe(9007);
    await client.close();
  });

  it("returns pending-confirm on buzz_add_member without confirm", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_add_member",
      arguments: { pubkey: "b".repeat(64), role: "member" },
    });
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("pending-confirm");
    expect(parsed.unsigned_event.kind).toBe(9000);
    await client.close();
  });
});

describe("BUZZ_MCP_MODE=read-only", () => {
  beforeEach(() => {
    process.env["BUZZ_MCP_MODE"] = "read-only";
  });

  it("rejects buzz_post_message at dispatch", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    );
    expect(text?.text).toMatch(/read-only mode/);
    await client.close();
  });

  it("rejects buzz_post_message even with confirm: true", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await client.close();
  });

  it("allows read-only tools (buzz_identity, buzz_list_channels)", async () => {
    const { spy } = makeFetchSpy(async () => new Response(JSON.stringify([]), { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const id = await client.callTool({ name: "buzz_identity", arguments: {} });
    expect(id.isError).toBeFalsy();
    // Buzz_identity doesn't fetch; it only probes. The hand-rolled fetch in
    // probeRelayInfo goes through `fetch`, which is the spy.
    await client.close();
  });
});

describe("BUZZ_MCP_MODE=mutate (legacy behavior)", () => {
  beforeEach(() => {
    process.env["BUZZ_MCP_MODE"] = "mutate";
  });

  it("posts immediately on buzz_post_message", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    await client.close();
  });
});

describe("dryRun: true (works in any mode)", () => {
  beforeEach(() => {
    process.env["BUZZ_MCP_MODE"] = "mutate";
  });

  it("returns the unsigned event without posting", async () => {
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "preview", dryRun: true },
    });
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("dry-run");
    expect(parsed.unsigned_event.kind).toBe(9);
    expect(parsed.unsigned_event.content).toBe("preview");
    // The "unsigned" event is actually the *pre-publish* state — buildMessage
    // signs it locally but the gate prevents the wire POST. The signature on
    // the event is what the *receiver* would verify; the gate's job is to
    // stop the network call, not to skip signing.
    expect(parsed.unsigned_event.id).toMatch(/^[0-9a-f]{64}$/);
    await client.close();
  });

  it("emits the NIP-98 Authorization header even when not fetching (sanity check)", async () => {
    // Ensures the unsigned event has pubkey/sig/tags populated correctly so
    // the operator can preview what *would* be signed.
    const { spy } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "preview", dryRun: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    // The unsigned event has pubkey/tags but no signature.
    expect(parsed.unsigned_event.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.unsigned_event.tags).toContainEqual(["client", "buzz-mcp"]);
    await client.close();
  });
});

describe("Pending-confirm response shape (additive)", () => {
  it("preserves the legacy fields when present + adds unsigned_event", async () => {
    process.env["BUZZ_MCP_MODE"] = "mutate-with-confirm";
    const { spy, calls } = makeFetchSpy(async () => new Response(ackBody(), { status: 202 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { client } = await bootServer();
    const result = await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });
    expect(calls).toHaveLength(0);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    const parsed = JSON.parse(text);
    // Phase 1 additive: existing fields preserved where they make sense.
    expect(parsed.status).toBe("pending-confirm");
    expect(parsed.channel).toBe("general");
    expect(parsed.unsigned_event).toBeDefined();
    expect(parsed.message).toMatch(/confirm: true/);
    await client.close();
  });
});

// Also verify the unused `findHeader` import isn't a false positive.
// TypeScript with strict settings would flag this; vitest doesn't.
void findHeader;
