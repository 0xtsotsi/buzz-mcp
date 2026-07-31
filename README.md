# @buzz/mcp

> TypeScript [Model Context Protocol][mcp] (MCP) server for the
> [CorePrt][coreprt] Nostr relay. Exposes **16 tools** for talking to a
> CorePrt Nostr relay: identity, channels, messages, fetch & search, jobs,
> workflows, media, thread summaries, and WebSocket subscriptions. One
> operator identity per process, signed by `BUZZ_PRIVATE_KEY`. Speaks NIP-98
> HTTP and NIP-42 WebSocket auth — no daemon, no Rust, just a stdio binary.

Run it as a child of any MCP-aware client (Claude Desktop, Cursor, Zed,
[ggcoder][ggcoder]) and gain a Buzz workspace of tools. The full
operator-facing manual is at [`docs/quickstart.md`](./docs/quickstart.md);
this README is the 60-second pitch.

---

## Status

All 6 planned PRs are **shipped**:

| PR  | Branch          | What it adds                                        |
| --- | --------------- | --------------------------------------------------- |
| #1  | `feat/scaffold` | package, stdio transport, McpServer factory         |
| #2  | `feat/signer`   | local nsec holder + NIP-98 signedFetch + BIP-340    |
| #3  | `feat/first-tool` | `buzz_post_message` + typed event builders        |
| #4  | `feat/tools`    | +11 more tools (identity, channels, fetch, jobs, media, summaries) |
| #5  | `feat/subscribe` | +3 tools (`buzz_subscribe`, `buzz_poll`, `buzz_unsubscribe`) |
| #6  | `feat/docs`     | this PR — `docs/quickstart.md`, `mcp-config.example.json`, `CHANGELOG.md` |

**Ready to tag: `v0.1.0`.**

---

## Tool list (16)

Tools are registered in alphabetical order (`REGISTERED_TOOLS` in
`src/index.ts`):

| Tool | Read/Write | One-line |
| ---- | ---------- | -------- |
| `buzz_add_member`        | write          | Publish a `kind:9000` NIP-29 `add_member` event. |
| `buzz_approve_workflow`  | write          | Publish `kind:46030` (approve) or `kind:46031` (reject) referencing a workflow. |
| `buzz_create_channel`    | write          | Publish a `kind:9007` NIP-29 `create_channel` event. |
| `buzz_create_job`        | write          | Publish a `kind:43001` `KIND_JOB_REQUEST` event. |
| `buzz_edit_message`      | write          | Publish a `kind:40003` edit referencing an existing message. |
| `buzz_fetch_events`      | read           | POST a NIP-01 filter to `/query`; returns the raw event array. |
| `buzz_identity`          | read           | Relay NIP-11 info doc + the operator's derived pubkey/npub. |
| `buzz_list_channels`     | read           | `kind:9007` NIP-29 channels visible to the operator. |
| `buzz_poll`              | read           | Drain buffered `EVENT` frames from a `sub_id` (FIFO). |
| `buzz_post_message`      | write          | Publish a `kind:9` NIP-29 stream message; reply via NIP-10. |
| `buzz_post_thread_summary` | write        | Publish a `kind:39005` `KIND_THREAD_SUMMARY` event. |
| `buzz_react`             | write          | Publish a `kind:7` NIP-25 reaction. |
| `buzz_search`            | read           | NIP-50 free-text search (falls back to client-side `includes`). |
| `buzz_subscribe`         | side-effect    | Open a `["REQ", sub_id, filter]` against the shared WS. |
| `buzz_unsubscribe`       | side-effect    | Send `["CLOSE", sub_id]` and drop it from the manager. |
| `buzz_upload_media`      | write          | `PUT /media/upload` (or `/upload`); base64 or CWD-scoped path; max 1 MiB. |

Grouped by category:

- **Identity & Channels** — `buzz_identity`, `buzz_list_channels`,
  `buzz_create_channel`, `buzz_add_member`.
- **Messages** — `buzz_post_message`, `buzz_edit_message`, `buzz_react`.
- **Fetch & Search** — `buzz_fetch_events`, `buzz_search`.
- **Jobs & Workflows** — `buzz_create_job`, `buzz_approve_workflow`.
- **Media & Summaries** — `buzz_upload_media`, `buzz_post_thread_summary`.
- **Subscriptions** — `buzz_subscribe`, `buzz_poll`, `buzz_unsubscribe`.

---

## Quickstart

```bash
# Recommended for production: npx, no install
npx @buzz/mcp

# From source
git clone https://github.com/0xtsotsi/buzz-mcp && cd buzz-mcp
npm install && npm run build
node dist/cli.js    # or: npm link && buzz-mcp
```

Then drop one of the three variants from
[`docs/mcp-config.example.json`](./docs/mcp-config.example.json) into
`~/.gg/mcp.json` (Track A pinned path, Track B `npx`, or Track B with raw
`${VAR}` env). Set `BUZZ_PRIVATE_KEY` in
`~/.config/coreprt/buzz-mcp.env` (`chmod 600`). Verify with `buzz_identity`.

The 60-second walkthrough, troubleshooting, and full env table are at
[`docs/quickstart.md`](./docs/quickstart.md).

---

## Package manager

This package is installed with **npm**, not pnpm. The lockfile committed
to this repo is `package-lock.json`. If your local environment only has
pnpm installed, get npm first (e.g. via `corepack enable && corepack
prepare npm@latest --activate`, or via your Node installer of choice) and
then run `npm install`. Do not commit a `pnpm-lock.yaml`.

---

## Requirements

- **Node.js ≥ 22** (declared in `engines.node`).
- **npm** ≥ 10.

## Build & run

```bash
npm run build          # → dist/index.js, dist/cli.js + .d.ts files
npm run typecheck      # tsc --noEmit on src/
npm run typecheck:test # tsc --noEmit on test/
npm start              # node dist/cli.js
node dist/cli.js       # explicit form
```

The process speaks MCP over **stdio** — point your MCP client at
`buzz-mcp` (or at `node /path/to/repo/dist/cli.js`) and the JSON-RPC
handshake runs automatically. The `BUZZ_PRIVATE_KEY` and `BUZZ_RELAY_URL`
env vars are read once at server boot; a missing `BUZZ_PRIVATE_KEY`
throws a clear error.

## Test

```bash
npm test               # vitest run — 93 tests across 13 files
```

The local **`block/buzz` integration test is deferred** — it spins up the
Rust relay via Docker Compose and needs `tmux` + `psql` on the operator's
Mac. A pure-JS happy-path suite (event building, signing, NIP-98 wrapping,
subscription FSM) covers the public tool surface in `npm test`.

---

## Layout

```text
.
├── src/
│   ├── index.ts           # createServer() factory — wires all 16 tools
│   ├── cli.ts             # stdio entry point — the `buzz-mcp` bin
│   ├── relay/             # signer + signedFetch (NIP-98) + subscription FSM
│   │   ├── client.ts
│   │   ├── event-builder.ts
│   │   ├── signer.ts
│   │   └── subscription.ts
│   ├── tools/             # one file per category
│   │   ├── identity.ts
│   │   ├── messages.ts
│   │   ├── fetch.ts
│   │   ├── jobs.ts
│   │   ├── media.ts
│   │   ├── summaries.ts
│   │   └── subscribe.ts
│   └── util/              # shared helpers
│       ├── relay-call.ts  # timeout + ack parsing + error envelope
│       └── zod.ts
├── test/
│   ├── index.spec.ts      # createServer() + MCP tools/list smoke
│   └── unit/              # 12 vitest specs covering each tool
├── docs/
│   ├── quickstart.md
│   └── mcp-config.example.json
├── package.json           # name, version, deps, bin
├── tsconfig.json          # ES2022 / NodeNext / strict
├── tsconfig.test.json
├── vitest.config.ts
├── CHANGELOG.md
├── NOTICE                 # Apache-2.0 attribution
└── LICENSE                # Apache-2.0
```

The compiled output lives in `dist/` and ships via the `files` field in
`package.json`.

---

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

The Nostr protocol is the work of the Nostr community; CorePrt is a
separate project maintained at <https://github.com/0xtsotsi/coreprt>.

[mcp]: https://modelcontextprotocol.io/
[coreprt]: https://github.com/0xtsotsi/coreprt
[ggcoder]: https://github.com/0xtsotsi/gg-framework
