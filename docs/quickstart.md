# `@buzz/mcp` — Operator Quickstart

## What this is

`@buzz/mcp` is a [Model Context Protocol][mcp] (MCP) server that exposes 16
tools for talking to a CorePrt Nostr relay. It speaks NIP-98 HTTP, NIP-42
WebSocket auth, and a small set of relay-specific event kinds. Run it as a
stdio child process from any MCP-aware client (Claude Desktop, Cursor, Zed,
[`ggcoder`][ggcoder], etc.); it holds one operator identity per process,
backed by `BUZZ_PRIVATE_KEY`.

## Install

Three ways to get the `buzz-mcp` binary on your machine.

### A. Via npm (once published)

```bash
npm install -g @buzz/mcp
buzz-mcp    # on PATH
```

### B. Via `npx` (no install — recommended for `~/.gg/mcp.json`)

```bash
npx @buzz/mcp
```

This is the form GG Coder and most MCP clients prefer. Update once on every
npx cache pass; there's no daemon to babysit.

### C. From source

```bash
git clone https://github.com/0xtsotsi/buzz-mcp
cd buzz-mcp
npm install
npm run build
node dist/cli.js    # or: npm link && buzz-mcp
```

You need **Node.js ≥ 22** and **npm ≥ 10**. There is no native compilation;
the signer (`@noble/curves`) and crypto (`@noble/hashes`) are pure JS.

## Configure

Three one-time steps.

### 1. Add the server entry to `~/.gg/mcp.json`

GG Coder reads this file at startup; the `buzz` entry tells it to spawn a
child process for the tools. A complete, copy-pasteable configuration
(including all three variants — pinned path, npx, and the env-raw fallback)
is at [`docs/mcp-config.example.json`](./mcp-config.example.json).

Minimum required fields:

```json
{
  "mcpServers": {
    "buzz": {
      "command": "npx",
      "args": ["-y", "@buzz/mcp"],
      "env": {
        "BUZZ_PRIVATE_KEY": "${env:BUZZ_PRIVATE_KEY}",
        "BUZZ_RELAY_URL": "https://coreprt.webrnds.com"
      }
    }
  }
}
```

### 2. Set `BUZZ_PRIVATE_KEY` in `~/.config/coreprt/buzz-mcp.env`

```bash
chmod 600 ~/.config/coreprt/buzz-mcp.env
echo "BUZZ_PRIVATE_KEY=nsec1your-key-here-or-64-char-hex-deadbeef..." >> ~/.config/coreprt/buzz-mcp.env
```

Either `nsec1…` bech32 or 64-char lowercase hex is accepted. The key is
**read once at `createServer()` time** (server boot) and held in a closure;
it is never re-read from disk and never logged.

### 3. Verify

From inside a GG Coder session, ask the agent:

> _Run `buzz_identity` and tell me what it returns._

Expected reply: a JSON blob containing `{ pubkey, npub, relay_path_used,
relay_status }`. The `pubkey` should match the one registered as a relay
member; `relay_status` should be 200. If you see `BUZZ_PRIVATE_KEY is not
set` instead, re-check step 2.

## First call (smoke test)

A minimal end-to-end: list the channels the operator is a member of.

```jsonc
// In a GG Coder session:
{
  "tool": "buzz_list_channels",
  "args": {}
}
```

The reply is an array of `kind:9007` NIP-29 `create_channel` events visible
to your pubkey:

```jsonc
{
  "channels": [
    {
      "id": "<64-hex event id>",
      "created_at": 1717300000,
      "name": "general",
      "visibility": "public",
      "raw": { /* full event */ }
    }
  ]
}
```

If the array is empty (likely — fresh operator key) you'll need to provision
channels before posting:

1. `buzz_create_channel({ "name": "general", "visibility": "public" })` →
   returns the relay-assigned `event_id` for the new channel.
2. `buzz_add_member({ "pubkey": "<teammate-hex>", "role": "member" })` →
   adds the teammate. **Repeat with `sleep 1` between calls** to avoid the
   kind:9000 → kind:44100 timestamp-collision rule (`CorePrt/run.sh:120`).
3. `buzz_post_message({ "channel": "general", "content": "hello world" })`
   → first message landed.

## Tool list (16)

All 16 tools exposed by `@buzz/mcp` v0.1.0, in registration order
(`REGISTERED_TOOLS` in `src/index.ts`):

### Identity & Channels

| Tool | One-line |
| ---- | -------- |
| `buzz_identity` | Relay NIP-11 info doc + the operator's derived pubkey/npub. |
| `buzz_list_channels` | `kind:9007` NIP-29 channels the operator can see. |
| `buzz_create_channel` | Publish a `kind:9007` `create_channel` event. |
| `buzz_add_member` | Publish a `kind:9000` `add_member` event (relay allocates the membership). |

### Messages

| Tool | One-line |
| ---- | -------- |
| `buzz_post_message` | Publish a `kind:9` NIP-29 stream message; reply via NIP-10. |
| `buzz_edit_message` | Publish a `kind:40003` edit referencing an existing message. |
| `buzz_react` | Publish a `kind:7` NIP-25 reaction. |

### Fetch & Search

| Tool | One-line |
| ---- | -------- |
| `buzz_fetch_events` | POST a NIP-01 filter to `/query`; returns the raw event array. |
| `buzz_search` | NIP-50 free-text search; falls back to client-side `includes` if the relay 4xx's. |

### Jobs & Workflows

| Tool | One-line |
| ---- | -------- |
| `buzz_create_job` | Publish a `kind:43001` `KIND_JOB_REQUEST` event. |
| `buzz_approve_workflow` | Publish `kind:46030` (approve) or `kind:46031` (reject) referencing a workflow. |

### Media & Summaries

| Tool | One-line |
| ---- | -------- |
| `buzz_upload_media` | `PUT /media/upload` (or `/upload`) with either base64 bytes or a CWD-scoped path; max 1 MiB. |
| `buzz_post_thread_summary` | Publish a `kind:39005` `KIND_THREAD_SUMMARY` referencing the thread's root. |

### Subscriptions

| Tool | One-line |
| ---- | -------- |
| `buzz_subscribe` | Open a `["REQ", sub_id, filter]` against the shared WS; returns a 32-hex `sub_id`. |
| `buzz_poll` | Drain up to `max` buffered `EVENT` frames from a `sub_id` (FIFO). |
| `buzz_unsubscribe` | Send `["CLOSE", sub_id]` and drop it from the manager. |

## Security notes

- `BUZZ_PRIVATE_KEY` is **read once at `createServer()` time** and held in a
  tool-handler closure. Never paste the key into a tool argument — passing
  it through a tool would log it into the MCP audit stream. The key is
  never re-read from disk, never written to stdout.
- `~/.config/coreprt/buzz-mcp.env` should be `chmod 600`. **Don't commit
  it**; don't share it across operators. One process == one identity.
- `buzz_upload_media` is **CWD-scoped**: `filePath` must resolve inside the
  operator's current working directory. Symlinks are followed (`realpathSync`)
  and re-validated. Files larger than **1 MiB** are rejected **before**
  reading so a 1 GiB file can't blow up the process. Use `data` (base64)
  for tiny blobs and `filePath` for anything bigger.
- `buzz_add_member` requires **`sleep 1` between back-to-back calls**.
  The relay's `kind:9000 → kind:44100` notification round-trip needs at
  least one second to settle or the second `add_member` will collide on the
  timestamp and be rejected. The tool does not enforce this — the calling
  agent is responsible.
- Subscriptions are **poll-only**. `buzz_subscribe` opens a REQ against the
  shared WebSocket and buffers events per `sub_id`; `buzz_poll` is the only
  way to read them out. No `notifications/*`, no server-sent stream — MCP
  is request/response and we honor that.
- Tools race their inner work against a 5-second timer (uploads use 30s).
  A stuck relay surfaces as a tool error, never as a hung tool call.

## Troubleshooting

### `Error: BUZZ_PRIVATE_KEY is not set`

The env block in `~/.gg/mcp.json` is missing the variable, the shell that
launched GG Coder has `unset BUZZ_PRIVATE_KEY` somewhere upstream, or
`~/.config/coreprt/buzz-mcp.env` isn't being sourced by your MCP client.
Check the file permissions (`chmod 600`) and content (no trailing newline
issues, no shell export lines — just `KEY=VALUE`).

### HTTP 401 on every call

`Nostr …` header shape wrong, or `BUZZ_PRIVATE_KEY` doesn't match the key
registered as a relay member. The relay verifies the NIP-98
`Authorization: [REDACTED] <base64(kind27235-event)>` header against the
kind:27235 event's `pubkey`; if that pubkey isn't a channel member, you'll
get a 401. Confirm by running `buzz_identity` first and cross-checking the
returned `pubkey` against the relay's member roster.

### HTTP 403 from Cloudflare Access

The relay sits behind Cloudflare Access; the `service-token-buzz-mcp`
policy (`Policy C` in `~/Documents/projects/CorePrt/docs/access-policy.md`)
requires a service token. Make sure `~/.config/coreprt/buzz-mcp.env`
contains a fresh `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` pair
issued by the Cloudflare Access dashboard; HTTP 403 usually means the pair
was rotated and the env file wasn't updated.

### WebSocket fails to open (`SubscriptionManager.start: gave up after 3 attempts`)

`BUZZ_RELAY_URL` is not a `ws://` or `wss://` URL — the WebSocket layer
takes the value verbatim, **no auto-conversion** from `https://`. Set it
explicitly:

```json
"BUZZ_RELAY_URL": "wss://coreprt.webrnds.com"
```

(If you're using `https://` for HTTP routes only, you may want to set
`BUZZ_WS_URL` separately — but v0.1.0 only honors `BUZZ_RELAY_URL`. Use one
URL for both with `wss://` until we split.)

## Development

```bash
npm install              # populate node_modules
npm run typecheck        # tsc --noEmit on src/
npm run typecheck:test   # tsc --noEmit on test/
npm run build            # tsc → dist/
npm test                 # vitest run — 93 tests across 13 files
npm run prepack          # alias for `npm run build` — runs in `npm publish` flow
```

The local **`block/buzz` integration test is deferred**. The full
end-to-end suite spins up the Rust relay via Docker Compose and needs
`tmux` + `psql` on the operator's Mac; neither is available by default.
A pure-JS happy-path coverage (event building, signing, NIP-98 wrapping,
subscription FSM) runs in `npm test`.

## License

Apache-2.0. See [`../LICENSE`](../LICENSE) and [`../NOTICE`](../NOTICE).

The Nostr protocol is the work of the Nostr community; CorePrt is a
separate project maintained at <https://github.com/0xtsotsi/coreprt>.

[mcp]: https://modelcontextprotocol.io/
[ggcoder]: https://github.com/0xtsotsi/gg-framework
