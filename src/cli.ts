#!/usr/bin/env node
/**
 * @buzz/mcp CLI entry point.
 *
 * Wires the McpServer produced by {@link createServer} to a
 * StdioServerTransport and awaits the connection. The MCP protocol
 * handshake (initialize → initialized → tools/list ...) is driven by the
 * connected client; this binary never reads stdin interactively.
 *
 * If the parent process closes stdin before sending a JSON-RPC message,
 * we shut the server down cleanly rather than block forever waiting on a
 * transport that will never produce an `initialize` request.
 */
import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./index.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.error(`@buzz/mcp: shutting down (${reason})`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  // Parent closed stdin before/during handshake → exit cleanly.
  process.stdin.on("end", () => {
    void shutdown("stdin closed");
  });
  process.stdin.on("close", () => {
    void shutdown("stdin closed");
  });

  // Best-effort signal handling.
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(`received ${signal}`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("@buzz/mcp: fatal error during startup:", err);
  process.exit(1);
});
