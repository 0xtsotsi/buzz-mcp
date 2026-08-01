/**
 * Unit tests for the four identity & channel tools:
 *   buzz_identity, buzz_list_channels, buzz_create_channel, buzz_add_member
 *
 * Uses the same in-memory MCP client + stubbed fetch pattern as
 * post-message-tool.spec.ts from PR #3.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerAddMemberTool,
  registerCreateChannelTool,
  registerIdentityTool,
  registerListChannelsTool,
} from "../../src/tools/identity.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const RELAY = "https://relay.test";
const EXPECTED_PUBKEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

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

describe("buzz_identity", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("probes /api/identity, returns the parsed body + operator pubkey + npub", async () => {
    const info = {
      name: "Buzz Relay",
      supported_nips: [1, 11],
      limitation: { max_message_length: 65536 },
    };
    fetchSpy = makeFetchSpy(
      async (_url) =>
        new Response(JSON.stringify(info), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerIdentityTool);
    const result = await client.callTool({ name: "buzz_identity", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].url).toBe(`${RELAY}/api/identity`);
    expect(fetchSpy.calls[0].init.method).toBe("GET");

    const parsed = parseText(result) as {
      relay: unknown;
      operator: { pubkey: string; npub: string };
      relay_path_used: string;
    };
    expect(parsed.relay).toEqual(info);
    expect(parsed.operator.pubkey).toBe(EXPECTED_PUBKEY);
    expect(parsed.operator.npub).toMatch(/^npub1/);
    expect(parsed.relay_path_used).toBe("/api/identity");

    await client.close();
  });

  it("falls back to /info when /api/identity returns non-2xx", async () => {
    const info = { name: "fallback" };
    fetchSpy = makeFetchSpy(async (url) => {
      if (url.endsWith("/api/identity")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(info), { status: 200 });
    });
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerIdentityTool);
    const result = await client.callTool({ name: "buzz_identity", arguments: {} });

    const parsed = parseText(result) as { relay: unknown; relay_path_used: string };
    expect(parsed.relay).toEqual(info);
    expect(parsed.relay_path_used).toBe("/info");

    await client.close();
  });
});

describe("buzz_list_channels", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs a kind:9007 query and derives name from the ["name"] tag', async () => {
    const event = {
      id: "a".repeat(64),
      pubkey: EXPECTED_PUBKEY,
      created_at: 1700000000,
      kind: 9007,
      tags: [
        ["name", "general"],
        ["visibility", "public"],
      ],
      content: "",
      sig: "b".repeat(128),
    };
    fetchSpy = makeFetchSpy(async () => new Response(JSON.stringify([event]), { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerListChannelsTool);
    const result = await client.callTool({
      name: "buzz_list_channels",
      arguments: {},
    });

    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].url).toBe(`${RELAY}/query`);
    expect(fetchSpy.calls[0].init.method).toBe("POST");
    const authHeader =
      fetchSpy.calls[0].init.headers["authorization"] ??
      fetchSpy.calls[0].init.headers["Authorization"];
    expect(authHeader).toMatch(/^Nostr /);
    const body = JSON.parse(fetchSpy.calls[0].init.body);
    expect(body.kinds).toEqual([9007]);
    expect(body.authors).toEqual([EXPECTED_PUBKEY]);

    const parsed = parseText(result) as {
      channels: Array<{ id: string; name: string; visibility: string }>;
    };
    expect(parsed.channels).toHaveLength(1);
    expect(parsed.channels[0].id).toBe("a".repeat(64));
    expect(parsed.channels[0].name).toBe("general");
    expect(parsed.channels[0].visibility).toBe("public");

    await client.close();
  });

  it("surfaces a 4xx response as a tool error", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("forbidden", { status: 403 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerListChannelsTool);
    const result = await client.callTool({
      name: "buzz_list_channels",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 403/);

    await client.close();
  });
});

describe("buzz_create_channel", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a kind:9007 event to /events with a NIP-98 Authorization header", async () => {
    const ack = { ok: true, event_id: "c".repeat(64) };
    fetchSpy = makeFetchSpy(async () => new Response(JSON.stringify(ack), { status: 202 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerCreateChannelTool);
    const result = await client.callTool({
      name: "buzz_create_channel",
      arguments: {
        name: "general",
        visibility: "private",
        description: "the main lobby",
      },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/events`);
    expect(call.init.method).toBe("POST");
    const auth = call.init.headers["authorization"] ?? call.init.headers["Authorization"];
    expect(auth).toMatch(/^Nostr /);

    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(9007);
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sig).toMatch(/^[0-9a-f]{128}$/);
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "name")).toEqual(["name", "general"]);
    expect(tags.find((t) => t[0] === "visibility")).toEqual(["visibility", "private"]);
    // description becomes an `["about", ...]` tag.
    expect(tags.find((t) => t[0] === "about")).toEqual(["about", "the main lobby"]);

    const parsed = parseText(result) as {
      event_id: string;
      accepted: boolean;
      channel: { name: string; visibility: string };
    };
    expect(parsed.event_id).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.accepted).toBe(true);
    expect(parsed.channel.name).toBe("general");
    expect(parsed.channel.visibility).toBe("private");

    await client.close();
  });

  it("surfaces a non-2xx as an error", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("nope", { status: 400 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerCreateChannelTool);
    const result = await client.callTool({
      name: "buzz_create_channel",
      arguments: { name: "x" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 400/);
    await client.close();
  });
});

describe("buzz_add_member", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a kind:9000 event with p + role tags", async () => {
    const member = "9".repeat(64);
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerAddMemberTool);
    const result = await client.callTool({
      name: "buzz_add_member",
      arguments: { pubkey: member, role: "admin" },
    });

    const call = fetchSpy.calls[0];
    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(9000);
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "p")).toEqual(["p", member]);
    expect(tags.find((t) => t[0] === "role")).toEqual(["role", "admin"]);

    const parsed = parseText(result) as {
      member: { pubkey: string; role: string };
      accepted: boolean;
    };
    expect(parsed.member.pubkey).toBe(member);
    expect(parsed.member.role).toBe("admin");
    expect(parsed.accepted).toBe(true);
    await client.close();
  });

  it("defaults role to member when omitted", async () => {
    const member = "8".repeat(64);
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerAddMemberTool);
    const result = await client.callTool({
      name: "buzz_add_member",
      arguments: { pubkey: member },
    });

    const body = JSON.parse(fetchSpy.calls[0].init.body);
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "role")).toBeUndefined();

    const parsed = parseText(result) as { member: { role: string } };
    expect(parsed.member.role).toBe("member");
    await client.close();
  });

  it("rejects a non-hex pubkey at the Zod layer", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerAddMemberTool);
    const result = await client.callTool({
      name: "buzz_add_member",
      arguments: { pubkey: "not-hex" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
