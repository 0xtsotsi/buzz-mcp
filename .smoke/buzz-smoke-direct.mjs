#!/usr/bin/env node
/**
 * Smoke test WITHOUT the public hostname. Targets the relay directly via
 * the colima VM port-forward at http://127.0.0.1:3300.
 *
 * Cloudflare Access is blocked on the public hostname regardless of the
 * tunnel state; the tunnel itself is healthy. This bypass proves the MCP
 * stack end-to-end (handshake → NIP-98 sign → /events POST → relay ack).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENV_FILE = resolve(process.env.HOME, ".config/coreprt/buzz-mcp.env");
const CLI_PATH = "/Users/gogetta/Documents/projects/buzz-mcp/dist/cli.js";
const RELAY_URL = "http://127.0.0.1:3300";

function loadEnvFile(path) {
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    )
      val = val.slice(1, -1);
    out[line.slice(0, eq).trim()] = val;
  }
  return out;
}

const envFromFile = loadEnvFile(ENV_FILE);
const childEnv = {
  ...process.env,
  ...envFromFile,
  BUZZ_RELAY_URL: RELAY_URL,
};

console.log("── env loaded from", ENV_FILE);
console.log(`   BUZZ_RELAY_URL      = ${RELAY_URL}`);
console.log(`   BUZZ_PRIVATE_KEY    = ${childEnv.BUZZ_PRIVATE_KEY ? "set (len=" + childEnv.BUZZ_PRIVATE_KEY.length + ")" : "MISSING"}`);
console.log(`   MINIMAX_API_KEY     = ${childEnv.MINIMAX_API_KEY ? "set (len=" + childEnv.MINIMAX_API_KEY.length + ")" : "(not in env)"}`);

const transport = new StdioClientTransport({
  command: "node",
  args: [CLI_PATH],
  env: childEnv,
});

const client = new Client(
  { name: "buzz-smoke-direct", version: "0.0.1" },
  { capabilities: {} },
);

let exitCode = 0;
try {
  await client.connect(transport);
  console.log("\n── MCP handshake complete");
  const sv = client.getServerVersion?.();
  console.log(`   server: ${sv?.name} v${sv?.version}`);

  // 1. list tools
  const { tools } = await client.listTools();
  console.log(`\n── tools/list → ${tools.length} tools`);

  // 2. buzz_identity
  console.log("\n── buzz_identity");
  const id = await client.callTool({ name: "buzz_identity", arguments: {} });
  const idText = textOf(id);
  let idParsed = null;
  try {
    idParsed = JSON.parse(idText);
  } catch {}
  console.log(
    idParsed?.operator
      ? `   operator=${idParsed.operator.npub}  relay_status=${idParsed.relay_status}`
      : "   raw: " + idText.slice(0, 200),
  );

  // 3. buzz_list_channels
  console.log("\n── buzz_list_channels");
  const lc = await client.callTool({ name: "buzz_list_channels", arguments: {} });
  const lcText = textOf(lc);
  let lcParsed = null;
  try {
    lcParsed = JSON.parse(lcText);
  } catch {}
  const channelNames = Array.isArray(lcParsed?.channels)
    ? lcParsed.channels.map((c) => c.name)
    : [];
  console.log(`   channels visible: [${channelNames.join(", ") || "(none)"}]`);

  // 4. buzz_post_message
  const content = "hello world 🦡 (buzz-mcp smoke test, direct via 127.0.0.1:3300)";
  console.log(`\n── buzz_post_message  channel=general`);
  console.log(`   content: ${JSON.stringify(content)}`);
  const post = await client.callTool({
    name: "buzz_post_message",
    arguments: { channel: "general", content },
  });
  const postText = textOf(post);
  let postParsed = null;
  try {
    postParsed = JSON.parse(postText);
  } catch {}
  console.log(`   ` + postText.slice(0, 400).replace(/\n/g, "\n   "));
  if (postParsed?.event_id) {
    console.log(`\n✅  posted to coreprt general — event_id=${postParsed.event_id}`);
  } else {
    console.log(`\n⚠   post returned WITHOUT a recognisable event_id`);
    exitCode = 3;
  }
} catch (err) {
  console.error("\n✖ smoke test failed:", err);
  exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {}
  process.exit(exitCode);
}

function textOf(result) {
  const blocks = result?.content ?? [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}
