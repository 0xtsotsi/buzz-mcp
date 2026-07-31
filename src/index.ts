/**
 * @buzz/mcp — TypeScript MCP server for the CorePrt Nostr relay.
 *
 * PR #3 introduces the first MCP tool (`buzz_post_message`).
 * Subsequent PRs will add the remaining 15 tools and a WebSocket
 * subscription model. No ACP harness integration is planned.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type NsecOrHex } from "./relay/signer.js";
import { registerPostMessageTool } from "./tools/messages.js";

const SERVER_NAME = "@buzz/mcp";
const SERVER_VERSION = "0.1.0";

const DEFAULT_RELAY_URL = "https://coreprt.webrnds.com";

function buildInstructions(relayUrl: string, tools: string[]): string {
  return [
    "@buzz/mcp is an MCP server for the CorePrt Nostr relay.",
    "",
    `Relay: ${relayUrl}`,
    "",
    "Tools registered in this build:",
    ...tools.map((t) => `  - ${t}`),
    "",
    "All signed writes go through the operator's BUZZ_PRIVATE_KEY env var.",
    "The key is read once at createServer() time and never re-read.",
  ].join("\n");
}

/**
 * Construct a fresh McpServer instance.
 *
 * Reads `BUZZ_PRIVATE_KEY` and `BUZZ_RELAY_URL` from the environment at
 * call time. Throws a clear error if `BUZZ_PRIVATE_KEY` is missing.
 *
 * The relay URL defaults to "https://coreprt.webrnds.com" if unset.
 */
export function createServer(): McpServer {
  const secret = process.env["BUZZ_PRIVATE_KEY"] as NsecOrHex | undefined;
  if (!secret) {
    throw new Error(
      "BUZZ_PRIVATE_KEY is not set. Add it to the env block in ~/.gg/mcp.json.",
    );
  }

  const relayUrl = process.env["BUZZ_RELAY_URL"] ?? DEFAULT_RELAY_URL;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {},
      instructions: buildInstructions(relayUrl, ["buzz_post_message"]),
    },
  );

  registerPostMessageTool(server, secret, relayUrl);

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
