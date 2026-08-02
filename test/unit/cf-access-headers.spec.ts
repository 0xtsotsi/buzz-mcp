/**
 * Unit tests for the Cloudflare Access service-token header forwarding added
 * to `signedFetch` (via `signedFetchWithTimeout`) in PR #fix/cloudflare-access-headers.
 *
 * The relay at `https://coreprt.webrnds.com` is gated by Cloudflare Access.
 * When the operator sets BOTH `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
 * in the env at `createServer()` time, every signedFetch automatically
 * forwards `CF-Access-Client-Id` + `CF-Access-Client-Secret` so the request
 * reaches the NIP-98 layer. If either env var is missing, the headers must
 * NOT appear (preserves the local-relay dev case where CF Access isn't in
 * the path). The secret itself never appears in tool-result payloads or logs.
 *
 * Uses the same InMemoryTransport + stubbed-fetch pattern as
 * `post-message-tool.spec.ts`. Hits `buzz_post_message` end-to-end via the
 * MCP client because it's the simplest sign-and-POST path and exercises the
 * `signedFetchWithTimeout` plumbing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/index.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const RELAY = "https://relay.test";

const CF_ID_ENV = "CF_ACCESS_CLIENT_ID";
const CF_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET";

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

async function makeServerAndClient() {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { server, client };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  // Header names are case-insensitive. Test fixtures keep them as the canonical
  // case (`Authorization`, `CF-Access-Client-Id`, …) but be defensive.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return headers[k];
  }
  return undefined;
}

describe("Cloudflare Access header forwarding", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Always wipe CF-Access env vars before each test so they don't leak from
    // the operator's shell (this worktree's dev env may have them set).
    delete process.env[CF_ID_ENV];
    delete process.env[CF_SECRET_ENV];
    // Required by createServer() — set every test.
    process.env["BUZZ_PRIVATE_KEY"] = SECRET;
    process.env["BUZZ_RELAY_URL"] = RELAY;
    // Phase 1: BUZZ_MCP_MODE defaults to `mutate-with-confirm`. The existing
    // CF-Access header tests pre-date Phase 1 and expect the request to fire
    // immediately; opt back into the v0.1.x behavior here.
    process.env["BUZZ_MCP_MODE"] = "mutate";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("forwards CF-Access-Client-Id + CF-Access-Client-Secret when BOTH env vars are set", async () => {
    process.env[CF_ID_ENV] = "test-cf-client-id";
    process.env[CF_SECRET_ENV] = "test-cf-client-secret";

    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "a".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/events`);
    expect(findHeader(call.init.headers, "CF-Access-Client-Id")).toBe("test-cf-client-id");
    expect(findHeader(call.init.headers, "CF-Access-Client-Secret")).toBe("test-cf-client-secret");

    await client.close();
  });

  it("does NOT forward CF-Access headers when BOTH env vars are missing", async () => {
    // Explicitly delete (already deleted in beforeEach, but be explicit).
    delete process.env[CF_ID_ENV];
    delete process.env[CF_SECRET_ENV];

    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "b".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(findHeader(call.init.headers, "CF-Access-Client-Id")).toBeUndefined();
    expect(findHeader(call.init.headers, "CF-Access-Client-Secret")).toBeUndefined();
    // Sanity: content-type is still set by the tool.
    expect(findHeader(call.init.headers, "content-type")).toBe("application/json");

    await client.close();
  });

  it("does NOT forward CF-Access headers when only ONE of the two env vars is set", async () => {
    // Only CLIENT_ID set, CLIENT_SECRET missing → must NOT forward, to avoid
    // partial-config 401s from Cloudflare Access.
    process.env[CF_ID_ENV] = "test-cf-client-id-only";
    delete process.env[CF_SECRET_ENV];

    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "c".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(findHeader(call.init.headers, "CF-Access-Client-Id")).toBeUndefined();
    expect(findHeader(call.init.headers, "CF-Access-Client-Secret")).toBeUndefined();

    await client.close();
  });

  it("still emits the NIP-98 Authorization header alongside the CF-Access headers", async () => {
    process.env[CF_ID_ENV] = "test-cf-client-id";
    process.env[CF_SECRET_ENV] = "test-cf-client-secret";

    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true, id: "d".repeat(64) }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    await client.callTool({
      name: "buzz_post_message",
      arguments: { channel: "general", content: "hi" },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    const auth = findHeader(call.init.headers, "Authorization");
    expect(auth).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
    // CF-Access headers still present too (no collision / no overwrite).
    expect(findHeader(call.init.headers, "CF-Access-Client-Id")).toBe("test-cf-client-id");
    expect(findHeader(call.init.headers, "CF-Access-Client-Secret")).toBe("test-cf-client-secret");

    await client.close();
  });
});
