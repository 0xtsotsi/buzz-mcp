import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, REGISTERED_TOOLS } from "../src/index.js";

describe("createServer", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env["BUZZ_PRIVATE_KEY"];
    delete process.env["BUZZ_RELAY_URL"];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws a clear error when BUZZ_PRIVATE_KEY is missing", () => {
    expect(() => createServer()).toThrow(/BUZZ_PRIVATE_KEY/);
  });

  it("creates a server with all 13 tools registered when env is set", async () => {
    process.env["BUZZ_PRIVATE_KEY"] =
      "0000000000000000000000000000000000000000000000000000000000000001";
    process.env["BUZZ_RELAY_URL"] = "https://relay.test";
    const server = createServer();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      const { tools } = await client.listTools();
      // The MCP `tools/list` RPC is the public contract — assert against that,
      // not against the SDK's private _registeredTools field. The exported
      // REGISTERED_TOOLS constant is the single source of truth for both the
      // server's `instructions` text and this test.
      expect(tools.map((t) => t.name).sort()).toEqual([...REGISTERED_TOOLS].sort());
    } finally {
      await client.close();
    }
  });

  it("defaults BUZZ_RELAY_URL to coreprt.webrnds.com when unset", () => {
    process.env["BUZZ_PRIVATE_KEY"] =
      "0000000000000000000000000000000000000000000000000000000000000001";
    delete process.env["BUZZ_RELAY_URL"];
    const server = createServer();
    const instr = (server.server as unknown as { _instructions?: string })._instructions;
    expect(instr).toMatch(/coreprt\.webrnds\.com/);
  });
});
