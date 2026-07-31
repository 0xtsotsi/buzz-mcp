/**
 * Unit tests for buzz_create_job and buzz_approve_workflow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  registerApproveWorkflowTool,
  registerCreateJobTool,
} from "../../src/tools/jobs.js";

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

describe("buzz_create_job", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs a kind:43001 event with title + summary tags and the description in content", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerCreateJobTool);
    const result = await client.callTool({
      name: "buzz_create_job",
      arguments: {
        title: "ship X",
        description: "long description",
        budget: 1000,
        dueAt: "2026-12-31T00:00:00Z",
      },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const call = fetchSpy.calls[0];
    expect(call.url).toBe(`${RELAY}/events`);
    const auth =
      call.init.headers["authorization"] ?? call.init.headers["Authorization"];
    expect(auth).toMatch(/^Nostr /);

    const body = JSON.parse(call.init.body);
    expect(body.kind).toBe(43001);
    expect(body.content).toBe("long description");
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "title")).toEqual(["title", "ship X"]);
    expect(tags.find((t) => t[0] === "summary")).toEqual([
      "summary",
      "long description",
    ]);
    expect(tags.find((t) => t[0] === "amount")).toEqual(["amount", "1000"]);
    expect(tags.find((t) => t[0] === "due")).toEqual([
      "due",
      "2026-12-31T00:00:00Z",
    ]);

    const parsed = parseText(result) as {
      event_id: string;
      accepted: boolean;
      job: { title: string; budget: number };
    };
    expect(parsed.accepted).toBe(true);
    expect(parsed.job.title).toBe("ship X");
    expect(parsed.job.budget).toBe(1000);
    await client.close();
  });

  it("surfaces a 4xx as an error", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response("no", { status: 422 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerCreateJobTool);
    const result = await client.callTool({
      name: "buzz_create_job",
      arguments: { title: "t", description: "d" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 422/);
    await client.close();
  });
});

describe("buzz_approve_workflow", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs kind 46030 (grant) for decision=approve", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerApproveWorkflowTool);
    const result = await client.callTool({
      name: "buzz_approve_workflow",
      arguments: { workflowId: "1".repeat(64), decision: "approve" },
    });

    const body = JSON.parse(fetchSpy.calls[0].init.body);
    expect(body.kind).toBe(46030);
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "e")).toEqual(["e", "1".repeat(64)]);

    const parsed = parseText(result) as {
      accepted: boolean;
      workflow: { decision: string; id: string };
    };
    expect(parsed.accepted).toBe(true);
    expect(parsed.workflow.decision).toBe("approve");
    expect(parsed.workflow.id).toBe("1".repeat(64));
    await client.close();
  });

  it("POSTs kind 46031 (deny) for decision=reject with the comment in content", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerApproveWorkflowTool);
    const result = await client.callTool({
      name: "buzz_approve_workflow",
      arguments: {
        workflowId: "2".repeat(64),
        decision: "reject",
        comment: "no good",
      },
    });

    const body = JSON.parse(fetchSpy.calls[0].init.body);
    expect(body.kind).toBe(46031);
    expect(body.content).toBe("no good");
    const tags = body.tags as string[][];
    expect(tags.find((t) => t[0] === "comment")).toEqual(["comment", "no good"]);

    const parsed = parseText(result) as { workflow: { comment: string } };
    expect(parsed.workflow.comment).toBe("no good");
    await client.close();
  });

  it("defaults decision to approve when omitted", async () => {
    fetchSpy = makeFetchSpy(
      async () => new Response(JSON.stringify({ ok: true }), { status: 202 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient(registerApproveWorkflowTool);
    const result = await client.callTool({
      name: "buzz_approve_workflow",
      arguments: { workflowId: "3".repeat(64) },
    });

    const body = JSON.parse(fetchSpy.calls[0].init.body);
    expect(body.kind).toBe(46030);

    const parsed = parseText(result) as { workflow: { decision: string } };
    expect(parsed.workflow.decision).toBe("approve");
    await client.close();
  });
});