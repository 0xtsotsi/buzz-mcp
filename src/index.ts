/**
 * @buzz/mcp — TypeScript MCP server for the CorePrt Nostr relay.
 *
 * This is the scaffold (PR 1/6). It exposes the McpServer factory only,
 * with zero tools registered. Subsequent PRs will add a local nsec signer,
 * a relay client, and the first tools (publish_event, get_event,
 * subscribe_events, etc.).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVER_NAME = "@buzz/mcp";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "@buzz/mcp is an MCP server for the CorePrt Nostr relay.",
  "",
  "Current status: scaffold. No tools are registered yet.",
  "",
  "Once tools land (see upcoming PRs), this server will let an MCP client",
  "publish and subscribe to Nostr events signed with a local nsec held by",
  "the operator of this process. It will talk to a CorePrt relay over",
  "its websocket interface.",
  "",
  "Project: https://github.com/0xtsotsi/buzz-mcp",
  "Relay:   https://github.com/0xtsotsi/coreprt",
].join("\n");

/**
 * Construct a fresh McpServer instance. Each call returns an independent
 * server; transport lifetime is the caller's responsibility.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {},
      instructions: INSTRUCTIONS,
    },
  );

  // No tools registered yet — the handler installed on connect will return
  // `{ tools: [] }`. Tool registration lands in PRs 3 and 4.

  return server;
}

export { SERVER_NAME, SERVER_VERSION, INSTRUCTIONS };
