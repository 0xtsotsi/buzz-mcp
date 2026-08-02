# Changelog

All notable changes to `@buzz/mcp` are documented in this file. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — Phase 5 (multi-relay plan)

Rollout + documentation. No code changes — this phase ships the
operator-facing material for the Phases 1–4 rollout.

### Added

- **`docs/onboarding.md`** — 30-minute walkthrough for a new operator:
  install, configure, verify, modes, multi-relay, subscriptions, logs,
  troubleshooting. Patterned after `docs/2026-07-30-operator-runbook.md`.
- **`docs/smoke-test-plan.md`** — checklist for each downstream
  consumer (claude-cli, codex-cli, Buzz.app, self-test). Explicit
  rollback criteria.
- **`docs/mcp-config.example.json`** — two new variants:
  - `multi_relay_read_only`: the safe starting config for new operators.
  - `multi_relay_full_mutate`: the multi-relay config with full writes
    (opt-in only).

### Bumps

No version bump. Documentation-only release.

## [0.1.6] — 2026-08-02 (Phase 4)

Subscription multiplexing. PR #14.

## [0.1.5] — 2026-08-02 (Phase 3)

Multi-relay core. PR #13.

Adds subscription multiplexing. The existing `SubscriptionManager` (single
WebSocket) is now wrapped in a `MultiRelaySubscriptionManager` that fans
out a single `REQ` across every configured relay and dedupes events by
`id` on poll.

### Added

- **`src/relay/multi-subscription.ts` — `MultiRelaySubscriptionManager`**:
  - `subscribe(filter, opts)` issues a `REQ` on every relay in parallel.
  - `poll(subId, max)` drains events from every per-relay sub, dedupes
    by `id` ("first seen wins"), and returns the merged set with
    per-relay origin stripped.
  - `remaining(subId)` sums the per-relay queues.
  - `unsubscribe(subId)` sends `CLOSE` on every per-relay sub.
  - `close()` shuts down every per-relay WS.
  - Per-call `relays: [...]` overrides the configured relay list.
- **9 new tests** in `test/unit/multi-subscription.spec.ts`. All existing
  tests still pass; 203 tests total (was 194).

### Changed

- `createServer()` now constructs a `MultiRelaySubscriptionManager` and
  threads it through the three subscription tools. The per-relay
  `SubscriptionManager` instances are created on demand by a
  `createManager` callback.
- `buzz_subscribe` gains a `relays: string[]` per-call override.

### Test summary

`Test Files  23 passed (23)`
`Tests  203 passed (203)` (9 new in Phase 4)

Bumps version to 0.1.6.

## [0.1.4] — 2026-08-02 (Phase 2)

Observability. PR #12.

Adds observability. One new MCP tool (`buzz_get_stats`); the existing 16
tools now emit structured logs and have their outcomes recorded into a
per-relay stats store. Phase 3's `RelayPool` will pass the same store
across all relays.

### Added

- **`src/util/log.ts` — structured JSON logger.** Every emitted line is a
  single-line JSON object `{ ts, level, msg, ... }`. Two sinks, both
  configurable at `createServer()` time:
  - Stderr (always on). The default destination for the MCP transport.
  - An optional file sink (size-based rotation: 5 MB × 3 files). Set
    `BUZZ_MCP_LOG_FILE` to enable; the default path under Buzz.app is
    `~/Library/Logs/xyz.block.buzz.app/agents/<pid>/buzz-mcp.log`.
- **`src/relay/stats.ts` — `StatsStore` + `RelayStats`.** Per-relay stats
  (`calls_total`, `success`, `rejected_400..403`, `rejected_other`,
  `timeout`, `network_error`, `latency_p50_ms`, `latency_p95_ms`,
  `last_success_at`, `last_error_at`). One record per origin (scheme +
  host + port), so `https://x.test/events` and `https://x.test/query`
  merge. Latency is a fixed-size ring buffer (200 samples) — constant
  memory per relay.
- **`buzz_get_stats` MCP tool.** Returns the snapshot. Accepts optional
  `relay` URL to filter to one relay. Read-only, never gated by
  `BUZZ_MCP_MODE`.
- **`scripts/relay-health-check.sh`** — bash probe that checks each
  configured relay (NIP-11 + `/query` canary) and emits one JSON
  status line per relay. Exits non-zero on any unreachable relay.
  Designed for cron + launchd: `*/15 * * * * ~/Documents/projects/CorePrt/scripts/relay-health-check.sh >> ~/Library/Logs/relay-health.log 2>&1`.
- **`BUZZ_MCP_LOG` (enum: `debug|info|warn|error`)** now controls the
  log level. Default `info`. Phase 2 switches the schema from `string`
  to a strict enum.

### Changed

- `signedFetchWithTimeout` now accepts `extras: { stats, tool }`. When
  `stats` is provided, every call records its outcome into the
  `StatsStore`. When `tool` is provided, the log line carries the tool
  name. The change is backward-compatible — existing callers omit the
  5th argument and get the old behavior.
- `createServer()` instantiates a single `StatsStore` and a single
  `Logger`, and threads them through every write tool.

### Test summary

`Test Files  20 passed (20)`
`Tests  182 passed (182)` (38 new tests in Phase 2)

Bumps version to 0.1.4.

## [0.1.3] — 2026-08-02 (Phase 1)

Configuration discipline + dry-run safety. PR #11.

Adds configuration discipline + dry-run safety. No new MCP tools — the
existing 16 tools gain mode-aware behavior. Phase 3 (multi-relay `RelayPool`)
will consume the parsed `BUZZ_RELAY_URLS` array that this PR validates.

### Added

- **`src/config/schema.ts` — Zod schema for `process.env`.** Every env var
  the server reads is now validated at `createServer()` time. Bad config
  (missing `BUZZ_PRIVATE_KEY`, malformed `BUZZ_RELAY_URLS`, wrong-format
  secret) throws a `ZodError` with a clear message instead of silently
  falling through to a partial-config crash later. Exports:
  - `parseEnv()` → `BuzzConfig` (read-only snapshot).
  - `ModeSchema` (the three mode literals).
  - Default TTLs (`DEFAULT_CHANNEL_CACHE_TTL_MS`, `DEFAULT_TOOL_TIMEOUT_MS`).
- **`BUZZ_MCP_MODE` — three modes:**
  - `read-only` (default for new installations) — every write tool refuses
    at dispatch with a clear `MCP is in read-only mode` error.
  - `mutate-with-confirm` (Phase 1's new default) — write tools log the
    unsigned event JSON to stderr at WARN and return
    `{status: 'pending-confirm', unsigned_event, ...}` unless the caller
    passes `confirm: true`.
  - `mutate` (kept for opt-out) — write tools sign and post immediately
    (the v0.1.x behavior).
- **`dryRun: true` per write tool** — returns the signed event JSON
  without posting. Useful for previews; works in any mode.
- **`BUZZ_RELAY_URLS` (JSON array)** — Phase 1 validates the env;
  Phase 3 will iterate over it. Merged with `BUZZ_RELAY_URL` (singular
  wins) and deduped. Empty arrays fail at startup (Q3: silent fall-through
  is unsafe).
- **`BUZZ_RELAY_ALLOWED` (JSON array)** — optional allowlist. If set,
  every default relay must be in it; startup fails otherwise.
- **`BUZZ_RELAY_HOST_0..3`** — collected into `relayHosts` for Phase 3.
- **`src/util/mode.ts` — `gateWrite` chokepoint.** Every write tool
  routes through it before signing or posting. Pure (no IO), with an
  injectable `warn` sink for tests.

### Changed

- `createServer()` now calls `parseEnv()` and threads the resulting
  `BuzzConfig` into every write tool. Read tools receive the existing
  (secret, relayUrl, cfAccess) signature — Phase 1 keeps them on the
  single-relay path. Phase 3's `RelayPool` will widen that signature.
- Write tools now accept `dryRun: true` and `confirm: true` parameters.
  Both are optional and default to `undefined` (so existing callers keep
  working — but only in `mutate` mode; the new default of
  `mutate-with-confirm` will surface a `pending-confirm` response, which
  is the documented safety improvement).
- `test/unit/cf-access-headers.spec.ts` now sets `BUZZ_MCP_MODE=mutate`
  to keep its pre-Phase 1 assertions. The new `mode-write-tools.spec.ts`
  covers the Phase 1 behavior end-to-end.

### Backward compatibility

Operators who want to keep the v0.1.x behavior set
`BUZZ_MCP_MODE=mutate` in their env block, or pass `confirm: true` on
every write call. Operators who don't set `BUZZ_MCP_MODE` get the new
default of `mutate-with-confirm`.

### Known limitations

- The "unsigned event" surfaced in `pending-confirm` / `dry-run` responses
  is actually the *signed* event — `buildMessage` calls `signEvent`
  locally. The gate's job is to stop the network call, not to skip
  signing. v0.2 will switch to a pre-sign builder so the returned
  payload is truly unsigned.
- `BUZZ_RELAY_ALLOWED` is enforced at startup, not per call. Phase 3's
  `RelayPool` will enforce per-call.
- The `confirm: true` parameter is a *bypass* of the mutate-with-confirm
  prompt, not a resume of a pending event. The MCP server does not store
  pending events between calls; the second call rebuilds the event from
  args (different `created_at`, different event id). The plan calls this
  out as a v0.2 improvement.

## [0.1.0] — 2026-07-31

The first public cut of `@buzz/mcp`. Ships **16 MCP tools** and the shared
infra (signer, signedFetch, event builders, subscription FSM) behind them.
Closes PRs #1–#5 from `0xtsotsi/buzz-mcp` and adds the operator-facing
docs (PR #6).

### Added

- **16 MCP tools** (registered in alphabetical order in `REGISTERED_TOOLS`,
  `src/index.ts`):
  - Identity & channels: `buzz_identity`, `buzz_list_channels`,
    `buzz_create_channel`, `buzz_add_member`.
  - Messages: `buzz_post_message` (kind:9, NIP-29 stream),
    `buzz_edit_message` (kind:40003), `buzz_react` (kind:7, NIP-25).
  - Fetch & search: `buzz_fetch_events` (NIP-01 `/query`),
    `buzz_search` (NIP-50 with client-side fallback).
  - Jobs & workflows: `buzz_create_job` (kind:43001),
    `buzz_approve_workflow` (kind:46030 / 46031).
  - Media & summaries: `buzz_upload_media` (`PUT /media/upload`,
    CWD-scoped path, max 1 MiB) and `buzz_post_thread_summary`
    (kind:39005).
  - Subscriptions: `buzz_subscribe`, `buzz_poll`, `buzz_unsubscribe`
    — poll-only WS model over a shared singleton `SubscriptionManager`.
- **Shared infra**, every PR added one of:
  - `src/relay/signer.ts` — nsec holder + BIP-340 Schnorr signer
    (`@noble/curves`).
  - `src/relay/client.ts` — NIP-98 `Authorization: [REDACTED] <base64>` wrapper
    (`signedFetch`).
  - `src/relay/event-builder.ts` — typed builders for every event kind.
  - `src/relay/subscription.ts` — NIP-01 WS state machine + NIP-42 `AUTH`
    handshake + per-sub FIFO ring buffers.
  - `src/util/relay-call.ts` — `signedFetchWithTimeout` (5 s ceiling,
    `AbortController` race), `parseAckId` (normalizes
    `{ok,id}` / `{event_id,accepted}` ack shapes), and `formatRelayError`
    (consistent `relay(<url>): …` envelope).
  - `src/util/zod.ts` — shared `pubkey` / `event_id` / `channel_id` schemas.
- **Operator-facing docs:**
  - `docs/quickstart.md` — 270-line manual: what this is, the three install
    flavors (npm, `npx`, source), three-step configuration, an end-to-end
    `buzz_list_channels` / `buzz_create_channel` / `buzz_add_member` /
    `buzz_post_message` smoke test, the full 16-tool table grouped by
    category, the seven security notes (key handling, file perms, CWD
    scoping of uploads, `sleep 1` on `buzz_add_member`, poll-only
    subscriptions, 5 s/30 s tool timeouts), four-troubleshooting FAQ,
    dev workflow, license pointer.
  - `docs/mcp-config.example.json` — three paste-ready `mcpServers` blocks
    (Track A pinned path, Track B `npx` with `${env:…}`, Track B `npx`
    with raw `${VAR}`) sharing an `instatic` placeholder.
- **README refresh** — drops the scaffold-era "TODO" tool list and the
  per-PR status table; mirrors `docs/quickstart.md` and ships the real
  16-tool table grouped by category.

### Test coverage

- 93 `it()` across 13 files (`test/index.spec.ts` + 12 under `test/unit/`).
- Pure-JS happy-path only: signer golden tests, NIP-98 wrapping,
  event-builder canonical bytes, subscription FSM with an injected
  WebSocket stub.

### Deferred

- The real **`block/buzz` integration test** (Docker Compose up, all 16
  tools end-to-end, 50-parallel `buzz_post_message` race). Needs
  `tmux` + `psql` on the operator's Mac.
- `["h", uuid]` channel-UUID and `["d", token_hash]` workflow-approval
  canonical tag shapes — the Rust SDK uses different tag keys than
  v0.1.0 exposes. v0.2.0 will switch to whatever the SDK emits once the
  helpers land (`buildCreateChannel` and `buildWorkflowApproval` already
  carry the relevant comments).
- Multi-relay fan-out (`buzz-multi-mcp`). One process, one relay.

[0.1.0]: https://github.com/0xtsotsi/buzz-mcp/releases/tag/v0.1.0

## [0.1.1] - 2026-08-01

### Fixed
- **CF Access service-token headers forwarded on every `signedFetch` call.** When `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` are both set in the env at `createServer()` time, every outgoing relay request now carries `CF-Access-Client-Id` + `CF-Access-Client-Secret` alongside the existing NIP-98 `Authorization` header. This unblocks `@buzz/mcp` against the deployed `coreprt.webrnds.com` (gated by Cloudflare Access policy `service-token-buzz-mcp`). Behavior is unchanged when either env var is unset (local-relay development case).

### Added
- `CfAccess` type exported from `src/util/relay-call.ts` — `{ clientId: string; clientSecret: string }`.
- `signedFetchWithTimeout` accepts a 4th `cfAccess?` parameter that merges CF Access headers into the request bag.
- 4 new unit tests in `test/unit/cf-access-headers.spec.ts` covering: both env vars set → headers forwarded; both missing → headers absent; only one set → headers absent; NIP-98 `Authorization` still present.

### Notes
- The 16 tool functions each take `cfAccess?: CfAccess` as a 4th parameter. The 13 HTTP tools forward it through `signedFetchWithTimeout`; the 3 WebSocket subscription tools receive `_cfAccess` (underscore-prefixed, intentionally unused — WS doesn't traverse CF Access).
- `buzz_identity`'s NIP-11 probe uses plain `fetch` (not `signedFetch`) per the spec; it is NOT CF-Access-gated by this change. In practice the probe path is unauthenticated by design and will return 302 from CF Access if the env vars are unset. Future: `buzz_identity` should also forward CF-Access headers (small follow-up).
- The agent keypair (`5430c42f…`) was debugged in chat during v0.1.0 onboarding; rotate before any production use.

## [0.1.2] - 2026-08-01

### Fixed
- **`POST /query` wire-shape bug.** NIP-01 specifies `filters` as an **array** of filter objects, but `buzz_list_channels`, `buzz_fetch_events`, and `buzz_search` were sending a single map. The relay's strict deserializer rejected with HTTP 400 "invalid type: map, expected a sequence". Now wraps the filter in `[…]` at every `/query` call site. Behavior verified against `https://coreprt.webrnds.com`.

### Changed
- `src/util/relay-call.ts` — `postQuery` body now `[filter]` instead of `filter`.
- `src/tools/identity.ts` — `buzz_list_channels` body now `[filter]` instead of `filter`.

### Tests
- `test/unit/fetch-tools.spec.ts` — 4 tests updated to expect `[filter]` shape.
- `test/unit/identity-tool.spec.ts` — 1 test updated to expect `[filter]` shape.
- All 97 tests passing across 14 files.

### Notes
- The deferred `subject` → `h` tag fix for `buildMessage` is still pending (v0.1.3+). The current `["subject", ...]` placeholder works for `kind:9007` (channel create) but is rejected by some relays for `kind:9` (stream message) until switched to `["h", uuid]`.
