# Changelog

All notable changes to `@buzz/mcp` are documented in this file. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/).

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
