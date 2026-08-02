# Onboarding — `@buzz/mcp` for a new operator

> Updated 2026-08-02. Covers Phases 1–4 of the multi-relay rollout.

This is a 30-minute walkthrough for a new operator to set up `@buzz/mcp`,
the Model Context Protocol server that talks to a CorePrt Nostr relay.
The defaults are safe; the operator can opt out of the safety
mechanisms when they understand the tradeoffs.

## 1. Install

The MCP server is published as `@buzz/mcp` on npm. You can either pin a
local path (development) or let npx fetch the latest build (production).

For most operators, start with a local clone:

```bash
git clone https://github.com/0xtsotsi/buzz-mcp.git ~/Documents/projects/buzz-mcp
cd ~/Documents/projects/buzz-mcp
npm install
npm run build
```

Then point your MCP client at the local build. See `docs/mcp-config.example.json`
for the four variants:

- `trackA_local_pinned_path` — local clone (recommended for development).
- `trackB_npx` — npx fetch (recommended for production / shared machines).
- `trackB_npx_raw_env` — bare `${VAR}` when the client doesn't expand `${env:...}`.
- `multi_relay_read_only` — multi-relay with the safe default mode.
- `multi_relay_full_mutate` — multi-relay with full writes (opt-in only).

Copy the inner `mcpServers` block into your real `~/.gg/mcp.json`,
keeping any existing `instatic` entry.

## 2. Configure

The mandatory env vars:

| Var | Required | Example |
| --- | --- | --- |
| `BUZZ_PRIVATE_KEY` | yes | 64-char lowercase hex (the operator's nsec, decoded) |
| `BUZZ_RELAY_URL` | optional | `https://coreprt.webrnds.com` (default) |
| `BUZZ_RELAY_URLS` | optional | `["https://a.test","https://b.test"]` (JSON array) |

The relay URL is consulted in this order: `BUZZ_RELAY_URLS` first, then
`BUZZ_RELAY_URL`. If neither is set, the default `https://coreprt.webrnds.com`
is used. If both are set, the URLs are merged, deduplicated, and the
default relay is the first entry.

The recommended safe-mode env vars:

| Var | Default | Notes |
| --- | --- | --- |
| `BUZZ_MCP_MODE` | `mutate-with-confirm` | `read-only` for new installations |
| `BUZZ_MCP_LOG` | `info` | `debug` for verbose; `error` for quiet |
| `BUZZ_MCP_LOG_FILE` | unset | Path to a rotating file sink (5 MB × 3) |

The Cloudflare Access vars (for production relays behind CF Access):

| Var | Required | Notes |
| --- | --- | --- |
| `CF_ACCESS_CLIENT_ID` | production only | Service token client id |
| `CF_ACCESS_CLIENT_SECRET` | production only | Service token client secret |

Both must be set, or neither. When both are set, every signed fetch
forwards the `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers
alongside the NIP-98 `Authorization` header.

## 3. Verify

The cheapest end-to-end check is `./scripts/relay-health-check.sh`.
This script NIP-11 + `/query` probes every configured relay and emits
one JSON line per relay. The script exits non-zero if any relay is
unreachable — fix the relay URL or the CF Access service token.

A second check is `mcp__buzz__buzz_get_stats` (Phase 2). After a few
calls, the snapshot should show non-zero `calls_total` for every
relay you actually wrote to. Empty records mean the fan-out didn't
fire — usually a typo in `BUZZ_RELAY_URLS`.

## 4. Modes — the Phase 1 default

The default mode is `mutate-with-confirm`. Every write tool returns
`{status: "pending-confirm", unsigned_event: {...}}` to the MCP
client unless the caller passes `confirm: true`. The agent sees the
event payload, can show it to the operator, and re-calls with
`confirm: true` to actually publish.

This is the safe default. The relay operator can:

- Set `BUZZ_MCP_MODE=mutate` to disable the confirm prompt (the
  v0.1.x behavior). Write tools sign and post immediately.
- Set `BUZZ_MCP_MODE=read-only` to disable writes entirely. The agent
  can read channels, fetch events, and subscribe, but every write
  tool returns an error.

The `read-only` mode is the recommended starting point for new
installations. Operators graduate to `mutate-with-confirm` once they
understand the agent's behavior, then to `mutate` only when they have
explicitly opted out of the safety net.

## 5. Multi-relay — the Phase 3 fan-out

When `BUZZ_RELAY_URLS` has N entries, every write tool fans out across
all N relays. The response includes a `posts: [...]` array with one
entry per relay, showing whether each relay accepted the event.

For a single-relay write, pass `allowFanout: false` to the tool.
For a specific subset, pass `relays: [...]` to override the pool
default.

A 401 NIP-98 replay detected response is automatically retried once
after a 1.5 s sleep. If the retry still fails, the relay is marked
as not-accepted and the other relays continue.

## 6. Subscriptions — the Phase 4 multiplex

`buzz_subscribe` opens one WebSocket per configured relay. Events are
deduped by `id` across relays. The `posts: [...]` array is not used
for subscriptions — the MCP tool returns a single merged list of
events with the per-relay origin stripped.

The buffer cap is 1000 events per relay. If the dedup'd set is
smaller than the buffer, the tool drops the oldest events. The
`remaining(subId)` field reports the count of unsent events.

## 7. Logs

When `BUZZ_MCP_LOG_FILE` is set, the server writes a rotating JSON
log to that path. Each line is a single JSON object with
`{ts, level, msg, ...context}` fields. The default convention under
Buzz.app is `~/Library/Logs/xyz.block.buzz.app/agents/<pid>/buzz-mcp.log`.

The file rotates at 5 MB × 3 files (active + 2 backups). The
convention is the standard Unix logrotate style: `<file>.1`, `<file>.2`.

When the file sink fails (e.g., permission denied), the server
falls back to stderr and does **not** crash. The agent sees the
warn/error on its log pane.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Server fails at startup with a `ZodError` | Bad env config | Run `./scripts/relay-health-check.sh`; the env validator catches missing `BUZZ_PRIVATE_KEY`, malformed `BUZZ_RELAY_URLS`, etc. |
| Every write returns 401 | CF Access service token missing/wrong | Set both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` |
| `pending-confirm` every time | Default mode is `mutate-with-confirm` | Pass `confirm: true` on write calls, or set `BUZZ_MCP_MODE=mutate` to opt out |
| Stats show `rejected_401` with `replay` in the body | NIP-98 replay detected | The pool auto-retries once after 1.5 s. If it fails consistently, the relay is likely a mirror that just received the event. |
| Logs are missing | `BUZZ_MCP_LOG` is set to `error` or `warn` | Set `BUZZ_MCP_LOG=info` (or `debug`) |

## 9. Where to go next

- Read the implementation plan: `docs/2026-08-02-buzz-mcp-implementation-plan.md`.
- Browse the changelog: `CHANGELOG.md`.
- Inspect the schema: `src/config/schema.ts`.
- File issues: https://github.com/0xtsotsi/buzz-mcp/issues.
