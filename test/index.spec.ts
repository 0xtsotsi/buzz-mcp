import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "../src/index.js";

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

  it("creates a server with exactly one tool when env is set", () => {
    process.env["BUZZ_PRIVATE_KEY"] =
      "0000000000000000000000000000000000000000000000000000000000000001";
    process.env["BUZZ_RELAY_URL"] = "https://relay.test";
    const server = createServer();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toEqual(["buzz_post_message"]);
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
