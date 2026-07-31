import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createServer } from "../src/index.js";

/**
 * The @modelcontextprotocol/sdk tracks registered tools on a private
 * `_registeredTools` object. We reach for it via a narrow structural cast so
 * the test stays decoupled from the rest of the MCP SDK surface. If the SDK
 * renames the field, this test will surface that immediately.
 */
interface McpServerRegisteredTools {
  _registeredTools: Record<string, unknown>;
}

describe("createServer", () => {
  it("returns an McpServer with zero tools registered", () => {
    const server: McpServer = createServer();
    const internals = server as unknown as McpServerRegisteredTools;
    const names = Object.keys(internals._registeredTools);
    expect(names).toEqual([]);
    expect(names).toHaveLength(0);
  });
});
