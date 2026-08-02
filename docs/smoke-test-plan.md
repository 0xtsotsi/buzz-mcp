# Smoke test plan — `@buzz/mcp` v0.1.6 (multi-relay rollout)

> Updated 2026-08-02. Covers Phases 1–4. Run this checklist against any
> downstream consumer before marking the rollout complete.

The plan is intentionally minimal: each consumer is exercised
once against the new MCP server, and the new fields are verified to
either be ignored (legacy consumers) or applied (Buzz.app).

## Pre-conditions

1. The CorePrt relay is up at `https://coreprt.webrnds.com` (or the
   operator's local equivalent).
2. The MCP server is built: `cd ~/Documents/projects/buzz-mcp && npm install && npm run build`.
3. The agent's `BUZZ_PRIVATE_KEY` is configured in `~/.gg/mcp.json`
   (not in shell env, not in the repo).

## Consumer 1 — claude-cli

claude-cli is the legacy single-relay consumer. It was built before
Phases 1–4 and expects the v0.1.x response shape.

| Step | Expected | ✓ |
| --- | --- | --- |
| Launch `claude-cli` against the operator's normal config. | Starts cleanly. | |
| Run `buzz_post_message` with a public channel. | Returns an `event_id` and `accepted: true`. | |
| Inspect the response. | The response has `status: "ok"`, `event_id`, `accepted`, `posts` (optional), and per-tool extras (`channel`, `target`, etc.). **claude-cli ignores the new fields.** | |
| Run `buzz_get_stats`. | Returns an empty snapshot (no calls yet). | |
| Run `buzz_subscribe` with a kind filter. | Returns a `sub_id`. | |
| Run `buzz_poll`. | Returns `[]` (no events yet, or EOSE). | |

Goal: confirm the new fields are ignored and the legacy behavior
is preserved. **No code changes in claude-cli.**

## Consumer 2 — codex-cli

codex-cli is also a legacy single-relay consumer. Same expectations
as claude-cli.

| Step | Expected | ✓ |
| --- | --- | --- |
| Launch `codex-cli`. | Starts cleanly. | |
| Run `buzz_post_message`. | Returns a v0.1.x-shaped response. | |
| Run `buzz_get_stats`. | Returns a snapshot. | |
| Inspect the `posts` field. | codex-cli doesn't render it, but the field is present in the JSON. | |

Goal: confirm the new fields are present and ignored. **No code
changes in codex-cli.**

## Consumer 3 — Buzz.app

Buzz.app is the operator-facing desktop app. It has full knowledge
of the multi-relay config and the Phase 1 modes.

| Step | Expected | ✓ |
| --- | --- | --- |
| Launch Buzz.app. | Connects to the MCP server. | |
| Open the Buzz.app log pane. | One `server.start` JSON line per boot. | |
| Open the agent log file (the path `BUZZ_MCP_LOG_FILE` points to). | JSON lines, one per tool call. | |
| Run `buzz_post_message` with `dryRun: true`. | Returns the signed event JSON without posting. | |
| Run `buzz_post_message` with `confirm: true` (the `mutate-with-confirm` default). | Returns the event id. | |
| Switch `BUZZ_MCP_MODE` to `read-only` and restart. | Writes return a `read-only` error. | |
| Switch to `multi_relay_full_mutate` config (5 relays). | `buzz_post_message` fans out across 5 relays. `posts` array has 5 entries. | |
| Run `buzz_get_stats`. | Returns a per-relay snapshot. | |
| Run `buzz_subscribe` with a kind filter. | One WebSocket per relay opens. | |
| Publish an event from another relay. | The MCP `buzz_poll` returns the event (deduped across relays). | |
| Inspect the channel view. | Buzz.app's `apply_workspace` override should route new channels to the workspace's `defaultRelay` (per-relay control). | |

Goal: confirm Buzz.app renders the new fields, uses the new modes,
and the multi-relay flow is observable. **Buzz.app code is already
updated.**

## Consumer 4 — `@buzz/mcp` itself (Phase 5 self-test)

A few targeted checks against the package itself.

| Step | Expected | ✓ |
| --- | --- | --- |
| `npm test` | 203 tests pass. | |
| `npm run build` | Builds clean. | |
| `npx @biomejs/biome check src/ test/` | Lint clean (no errors). | |
| `./scripts/relay-health-check.sh` | Emits one JSON line per relay. Exit 0 if all reachable, 1 if any unreachable. | |
| `node -e 'require(\"./dist/cli.js\")'` | Starts the MCP transport. Exits cleanly on SIGINT. | |

## Rollout checklist

- [ ] claude-cli green
- [ ] codex-cli green
- [ ] Buzz.app green
- [ ] `@buzz/mcp` self-test green
- [ ] Operator has new BUZZ_RELAY_URLS in `~/.gg/mcp.json`
- [ ] Operator has verified with `buzz_get_stats` that fan-out is firing
- [ ] Operator has switched to `mutate-with-confirm` (or `read-only` for new installs)

## When to roll back

- If any consumer breaks on the new fields, the rollback is to
  revert the tag `v0.1.6` and re-pin `v0.1.5`. The fields are
  additive, so the rollback only affects the operator's ability to
  observe the fan-out (claude-cli / codex-cli keep working).
- If `multi_relay_full_mutate` config fans out and the operator
  doesn't want writes on every relay, set `BUZZ_MCP_MODE=read-only`
  for the new install until the operator has confirmed the relay
  list.
