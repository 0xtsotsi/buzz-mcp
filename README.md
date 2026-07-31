# @buzz/mcp

> TypeScript [Model Context Protocol][mcp] (MCP) server for the
> [CorePrt][coreprt] Nostr relay. Speak Nostr to any MCP-compatible
> client (Claude Desktop, Cursor, etc.) — no daemon, no plugin, just a
> stdio binary.

This is the scaffold. It wires up the package, the McpServer factory,
a stdio CLI entry point, and the test/build harness. **No tools are
registered yet.** Tools land in the PRs listed below.

---

## Status

| Step | PR  | Branch               | What it adds                                         |
| ---- | --- | -------------------- | ---------------------------------------------------- |
| 1    | ✅  | `feat/scaffold`      | this PR — package, stdio transport, zero tools       |
| 2    | ⏳  | `feat/signer`        | local nsec holder + NIP-19 decoding                  |
| 3    | ⏳  | `feat/first-tool`    | first tool: `publish_event`                           |
| 4    | ⏳  | `feat/tools`         | remaining read/write tools                           |
| 5    | ⏳  | `feat/subscribe`     | streaming `subscribe_events` tool                    |
| 6    | ⏳  | `feat/docs`          | site, examples, JSON-schema catalogue                |

---

## Planned tools (TODO)

The following tools are planned for upcoming PRs. **None are implemented
in this PR.** Names and shapes will be tightened as each PR lands.

- `publish_event` — sign and publish a kind-1 note (and other kinds later)
  using a nsec held by the local process; returns the event id and
  accepted-relay count.
- `get_event` — fetch a single Nostr event by id.
- `get_profile` — fetch a kind-0 metadata event for a given pubkey or
  npub.
- `search_events` — run a NIP-50 search against the CorePrt relay.
- `subscribe_events` — stream matching events into the MCP client
  (PR 5).
- `list_relays` / `get_relay_status` — operational tools for the
  multi-relay support coming later.

A full JSON-schema catalogue is on the roadmap (PR 6).

---

## Package manager

This package is installed with **npm**, not pnpm. The lockfile committed
to this repo is `package-lock.json`. If your local environment only has
pnpm installed, get npm first (e.g. via `corepack enable && corepack
prepare npm@latest --activate`, or via your Node installer of choice)
and then run `npm install`. Do not commit a `pnpm-lock.yaml`.

---

## Requirements

- **Node.js ≥ 22** (declared in `engines.node`)
- **npm** ≥ 10

## Install

```bash
npm install
```

This populates `node_modules/` and honours `package-lock.json`.

## Build

```bash
npm run build          # → dist/index.js, dist/cli.js + .d.ts files
npm run typecheck      # tsc --noEmit
```

## Run

After `npm run build`, the `buzz-mcp` binary is available two ways:

```bash
# Via the bin shim (after `npm link` or inside node_modules/.bin)
buzz-mcp

# Directly
npm start
# → node dist/cli.js

# Explicit
node dist/cli.js
```

The process speaks MCP over **stdio** — point your MCP client at
`buzz-mcp` (or at `node /path/to/repo/dist/cli.js`) and the JSON-RPC
handshake runs automatically.

## Test

```bash
npm test               # vitest run
```

The scaffold suite currently asserts that `createServer()` returns an
`McpServer` with **zero registered tools**. More tests land with each
future PR.

---

## Layout

```text
.
├── src/
│   ├── index.ts        # createServer() factory
│   └── cli.ts          # stdio entry point (the `buzz-mcp` bin)
├── test/
│   └── index.spec.ts   # vitest specs
├── package.json
├── tsconfig.json       # ES2022 / NodeNext / strict
├── vitest.config.ts
├── NOTICE              # Apache-2.0 attribution
└── LICENSE             # Apache-2.0
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
