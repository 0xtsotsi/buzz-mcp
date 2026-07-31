/**
 * @buzz/mcp — TypeScript MCP server for the CorePrt Nostr relay.
 *
 * PR #3 introduced the first MCP tool (`buzz_post_message`).
 * PR #4 adds 12 more (identity, channels, message edits/reactions,
 * fetch + search, jobs + workflow approvals, media upload, thread summaries).
 * PR #5 will add WebSocket subscriptions. PR #6 will add docs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type NsecOrHex } from "./relay/signer.js";
import {
  registerEditMessageTool,
  registerPostMessageTool,
  registerReactTool,
} from "./tools/messages.js";
import {
  registerAddMemberTool,
  registerCreateChannelTool,
  registerIdentityTool,
  registerListChannelsTool,
} from "./tools/identity.js";
import { registerFetchEventsTool, registerSearchTool } from "./tools/fetch.js";
import {
  registerApproveWorkflowTool,
  registerCreateJobTool,
} from "./tools/jobs.js";
import { registerUploadMediaTool } from "./tools/media.js";
import { registerPostThreadSummaryTool } from "./tools/summaries.js";

const SERVER_NAME = "@buzz/mcp";
const SERVER_VERSION = "0.1.0";

const DEFAULT_RELAY_URL = "https://coreprt.webrnds.com";

/**
 * All 13 tool names registered by this build, in alphabetical order. Kept
 * here as a single source of truth so the MCP `instructions` string and the
 * `test/index.spec.ts` assertion can both reference it.
 */
const REGISTERED_TOOLS: string[] = [
  "buzz_add_member",
  "buzz_approve_workflow",
  "buzz_create_channel",
  "buzz_create_job",
  "buzz_edit_message",
  "buzz_fetch_events",
  "buzz_identity",
  "buzz_list_channels",
  "buzz_post_message",
  "buzz_post_thread_summary",
  "buzz_react",
  "buzz_search",
  "buzz_upload_media",
];

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
      instructions: buildInstructions(relayUrl, REGISTERED_TOOLS),
    },
  );

  registerPostMessageTool(server, secret, relayUrl);
  registerEditMessageTool(server, secret, relayUrl);
  registerReactTool(server, secret, relayUrl);
  registerIdentityTool(server, secret, relayUrl);
  registerListChannelsTool(server, secret, relayUrl);
  registerCreateChannelTool(server, secret, relayUrl);
  registerAddMemberTool(server, secret, relayUrl);
  registerFetchEventsTool(server, secret, relayUrl);
  registerSearchTool(server, secret, relayUrl);
  registerCreateJobTool(server, secret, relayUrl);
  registerApproveWorkflowTool(server, secret, relayUrl);
  registerUploadMediaTool(server, secret, relayUrl);
  registerPostThreadSummaryTool(server, secret, relayUrl);

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
