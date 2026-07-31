/**
 * Unit tests for buzz_upload_media. Covers:
 *   - happy path with `data` (base64)
 *   - happy path with `filePath` (inside CWD)
 *   - `filePath` outside CWD throws (no traversal)
 *   - file > 1 MiB throws
 *   - both `data` and `filePath` set → reject
 *   - 4xx relay response surfaces
 *   - sha256 is computed client-side and matches
 *   - PUT to /media/upload preferred over /upload (404 falls through)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerUploadMediaTool } from "../../src/tools/media.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const RELAY = "https://relay.test";

interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | Uint8Array;
  };
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
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body instanceof Uint8Array
              ? init.body
              : "",
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
  registerUploadMediaTool(server, SECRET, RELAY);
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

describe("buzz_upload_media", () => {
  let fetchSpy: ReturnType<typeof makeFetchSpy>;
  let originalFetch: typeof fetch;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Create the temp dir inside the test CWD so the path-traversal
    // guard accepts the files. Using os.tmpdir() would always fail
    // because the test runs from inside the repo worktree.
    tmpDir = mkdtempSync(join(process.cwd(), "buzz-mcp-media-"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uploads base64 data to /media/upload and returns url+sha256", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const data = Buffer.from(bytes).toString("base64");
    const sha = createHash("sha256").update(bytes).digest("hex");

    fetchSpy = makeFetchSpy(async () =>
      new Response(JSON.stringify({ url: "https://relay.test/media/abc" }), {
        status: 201,
      }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "image/png", data },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].url).toBe(`${RELAY}/media/upload`);
    expect(fetchSpy.calls[0].init.method).toBe("PUT");
    expect(fetchSpy.calls[0].init.headers["content-type"]).toBe("image/png");
    const auth =
      fetchSpy.calls[0].init.headers["authorization"] ??
      fetchSpy.calls[0].init.headers["Authorization"];
    expect(auth).toMatch(/^Nostr /);
    // Body bytes match.
    const sentBytes = fetchSpy.calls[0].init.body as Uint8Array;
    expect(Array.from(sentBytes)).toEqual(Array.from(bytes));

    const parsed = parseText(result) as {
      url: string;
      sha256: string;
      mime: string;
      bytes: number;
    };
    expect(parsed.url).toBe("https://relay.test/media/abc");
    expect(parsed.sha256).toBe(sha);
    expect(parsed.mime).toBe("image/png");
    expect(parsed.bytes).toBe(bytes.byteLength);

    await client.close();
  });

  it("reads a small filePath and uploads its bytes", async () => {
    const filePath = join(tmpDir, "small.txt");
    const bytes = Buffer.from("hello world");
    writeFileSync(filePath, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");

    fetchSpy = makeFetchSpy(async () =>
      new Response(JSON.stringify({ url: "https://relay.test/media/x" }), {
        status: 201,
      }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "text/plain", filePath },
    });

    expect(fetchSpy.calls).toHaveLength(1);
    const parsed = parseText(result) as { sha256: string };
    expect(parsed.sha256).toBe(sha);
    await client.close();
  });

  it("rejects a filePath that resolves outside the CWD", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    // /tmp is outside the CWD for tests run inside the repo. Use a literal
    // outside-CWD path that we know exists.
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "text/plain", filePath: "/tmp/this-does-not-exist" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/must resolve to inside the operator's CWD/);
    expect(fetchSpy.calls).toHaveLength(0);
    await client.close();
  });

  it("rejects a file larger than 1 MiB", async () => {
    const filePath = join(tmpDir, "big.bin");
    // 1 MiB + 1 byte — exceeds cap.
    const buf = Buffer.alloc(1024 * 1024 + 1, 0);
    writeFileSync(filePath, buf);

    fetchSpy = makeFetchSpy(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "application/octet-stream", filePath },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/exceeds.*1 MiB/);
    expect(fetchSpy.calls).toHaveLength(0);
    await client.close();
  });

  it("rejects when both data and filePath are provided", async () => {
    fetchSpy = makeFetchSpy(async () => new Response("", { status: 200 }));
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "text/plain", data: "AAA=", filePath: "relative.txt" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("falls back from /media/upload to /upload on a 404 response", async () => {
    const data = Buffer.from(new Uint8Array([9, 9, 9])).toString("base64");
    fetchSpy = makeFetchSpy(async (url) => {
      if (url.endsWith("/media/upload")) {
        return new Response("not here", { status: 404 });
      }
      return new Response(JSON.stringify({ url: "https://relay.test/media/y" }), {
        status: 201,
      });
    });
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "image/png", data },
    });

    expect(fetchSpy.calls).toHaveLength(2);
    expect(fetchSpy.calls[0].url).toBe(`${RELAY}/media/upload`);
    expect(fetchSpy.calls[1].url).toBe(`${RELAY}/upload`);

    const parsed = parseText(result) as { url: string; uploaded_to: string };
    expect(parsed.url).toBe("https://relay.test/media/y");
    expect(parsed.uploaded_to).toBe(`${RELAY}/upload`);
    await client.close();
  });

  it("surfaces a non-404 error response as a tool error", async () => {
    const data = Buffer.from(new Uint8Array([1])).toString("base64");
    fetchSpy = makeFetchSpy(
      async () => new Response("forbidden", { status: 403 }),
    );
    globalThis.fetch = fetchSpy.spy as unknown as typeof fetch;

    const { client } = await makeServerAndClient();
    const result = await client.callTool({
      name: "buzz_upload_media",
      arguments: { mime: "image/png", data },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text",
    )!.text;
    expect(text).toMatch(/HTTP 403/);
    await client.close();
  });
});