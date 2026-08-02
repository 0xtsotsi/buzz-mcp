#!/usr/bin/env bash
#
# relay-health-check.sh — probe each configured relay and emit a JSON
# status line per relay. Exits non-zero if any relay is unreachable.
#
# Phase 2 of the multi-relay plan. Designed for cron + launchd.
#
# What it does:
#   1. Reads `BUZZ_RELAY_URL` (singular) and `BUZZ_RELAY_URLS` (JSON array)
#      from the environment. The latter shadows the former when both are
#      set. Mirrors the precedence in `src/config/schema.ts`.
#   2. For each relay, fetches `/api/identity` (the NIP-11 info doc) with
#      a 5-second timeout. Records the HTTP status and the wall-clock
#      latency.
#   3. Follows up with a `POST /query` for kind:0 (NIP-01 meta) — a
#      minimal filter — to confirm the relay accepts signed POSTs in
#      principle. (This is a *canary*; the call is unsigned and will
#      never be authoritative for write-availability.)
#   4. Emits one JSON line per relay to stdout. The format is:
#        {"ts":"...","relay":"...","nip11_status":...,"nip11_latency_ms":...,"query_status":...,"query_latency_ms":...,"ok":true|false}
#   5. Exits 0 if every relay is reachable (NIP-11 200 AND /query 200);
#      exits 1 if any relay is unreachable.
#
# Cron entry (per the plan):
#   */15 * * * * /Users/gogetta/Documents/projects/CorePrt/scripts/relay-health-check.sh >> ~/Library/Logs/relay-health.log 2>&1
#
# Dependencies: bash 3.2+, curl, python3. macOS ships all three.

set -uo pipefail

# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log_err() { echo "$(ts) ERROR $*" >&2; }

# ms timestamp, defaults to 0 if python3 fails.
now_ms() {
  python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo "0"
}

# curl HTTP status capture. Avoids the `000000` bug from `|| echo "000"`.
# Echoes "000" on curl failure (network error, timeout, etc.).
curl_status() {
  local url="$1"
  local s
  s=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || true)
  if [[ -z "$s" ]]; then
    echo "000"
  else
    echo "$s"
  fi
}

# curl POST status.
curl_post_status() {
  local url="$1"
  local body="$2"
  local s
  s=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "content-type: application/json" \
    -d "$body" "$url" 2>/dev/null || true)
  if [[ -z "$s" ]]; then
    echo "000"
  else
    echo "$s"
  fi
}

# ─────────────────────────────────────────────────────────────────────────
# Resolve relay list. Mirrors parseEnv() precedence.
# ─────────────────────────────────────────────────────────────────────────

relays=()
if [[ -n "${BUZZ_RELAY_URLS:-}" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    log_err "python3 missing; cannot parse BUZZ_RELAY_URLS"
    exit 2
  fi
  # Validate JSON. python3 exits non-zero on bad JSON — propagate.
  if ! parsed=$(python3 -c '
import json, sys
try:
    arr = json.loads(sys.argv[1])
except Exception as e:
    print(f"PARSE_ERROR: {e}", file=sys.stderr)
    sys.exit(1)
if not isinstance(arr, list):
    print(f"NOT_A_LIST: {type(arr).__name__}", file=sys.stderr)
    sys.exit(1)
if len(arr) == 0:
    print("EMPTY", file=sys.stderr)
    sys.exit(1)
print("\n".join(arr))
' "$BUZZ_RELAY_URLS" 2>&1); then
    log_err "BUZZ_RELAY_URLS is invalid: $parsed"
    exit 2
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && relays+=("$line")
  done <<< "$parsed"
fi
if [[ -n "${BUZZ_RELAY_URL:-}" ]]; then
  # Merge singular first, deduped.
  if [[ ${#relays[@]} -eq 0 ]] || [[ "${relays[0]}" != "$BUZZ_RELAY_URL" ]]; then
    relays=("$BUZZ_RELAY_URL" "${relays[@]}")
  fi
fi
if [[ ${#relays[@]} -eq 0 ]]; then
  relays=("https://coreprt.webrnds.com")
fi

# ─────────────────────────────────────────────────────────────────────────
# Per-relay probe. Each probe sets both bits and the global ok flag.
# ─────────────────────────────────────────────────────────────────────────

overall_ok=true

probe_one() {
  local relay="$1"
  local base="${relay%/}"
  local ok=true

  # NIP-11 probe.
  local start_ms nip11_status nip11_latency
  start_ms=$(now_ms)
  nip11_status=$(curl_status "$base/api/identity")
  nip11_latency=$(( $(now_ms) - start_ms ))
  if [[ "$nip11_status" != "200" ]]; then ok=false; fi

  # /query canary — minimal kind:0 filter, unsigned.
  local query_status query_latency
  start_ms=$(now_ms)
  query_status=$(curl_post_status "$base/query" '[{"kinds":[0],"limit":1}]')
  query_latency=$(( $(now_ms) - start_ms ))
  if [[ "$query_status" != "200" ]]; then ok=false; fi

  if [[ "$ok" == "false" ]]; then overall_ok=false; fi

  # Emit JSON line.
  printf '{"ts":"%s","relay":"%s","nip11_status":%s,"nip11_latency_ms":%s,"query_status":%s,"query_latency_ms":%s,"ok":%s}\n' \
    "$(ts)" "$relay" \
    "$nip11_status" "$nip11_latency" \
    "$query_status" "$query_latency" \
    "$ok"
}

for relay in "${relays[@]}"; do
  probe_one "$relay"
done

if [[ "$overall_ok" == "true" ]]; then
  exit 0
else
  exit 1
fi
