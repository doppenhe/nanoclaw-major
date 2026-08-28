#!/usr/bin/env bash
# FORK-LOCAL — shmem health check for the Major agents (not upstream).
#
# Verifies the whole memory path the container agents depend on and alerts
# Diego on Telegram when it breaks. Runs from the systemd user timer
# `nanoclaw-shmem-check.timer` (see docs/LOCAL.md → "shmem health check").
#
#   1. nanoclaw-shmem.service is active
#   2. the shared shmem MCP server answers initialize + tools/call recall_memory
#   3. every group with a `shmem` MCP entry points at host.docker.internal
#      (NOT the bridge IP — the host validator drops plain-HTTP bridge-IP URLs
#      at spawn, and the OneCLI proxy would clobber the bearer), and the
#      materialized groups/<folder>/container.json still carries the entry
#   4. every running agent container can reach the server through its normal
#      env (NO_PROXY must include host.docker.internal)
#
# Usage: scripts/fork-shmem-healthcheck.sh [--notify-ok] [-v]
#   --notify-ok  also send a Telegram message when everything is fine
#   -v           print each check result
# Exit 0 = healthy, 1 = at least one check failed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_ENV="${SHMEM_SERVER_ENV:-$HOME/.config/nanoclaw/shmem-server.env}"
HOST_URL="${SHMEM_MCP_HOST_URL:-http://172.17.0.1:8705/mcp}"      # reachable from the host
CONTAINER_URL="http://host.docker.internal:8705/mcp"               # what groups must be configured with
STATE="$REPO/data/shmem-healthcheck.state.json"
LOG="$REPO/logs/shmem-healthcheck.log"
CHAT_ID="${SHMEM_ALERT_CHAT_ID:-5214488088}"                       # telegram:<id> of the owner
REALERT_SECS=$((6 * 3600))                                         # re-nag interval while still down

NOTIFY_OK=0; VERBOSE=0
for a in "$@"; do case "$a" in --notify-ok) NOTIFY_OK=1 ;; -v|--verbose) VERBOSE=1 ;; esac; done

fails=(); notes=()
fail() { fails+=("$1"); [ "$VERBOSE" = 1 ] && echo "FAIL  $1"; }
note() { notes+=("$1"); [ "$VERBOSE" = 1 ] && echo "ok    $1"; }
strip() { sed -e 's/^[^=]*=//' -e "s/^[\"']//" -e "s/[\"']$//"; }

KEY=$(grep -E '^SHMEM_API_KEY=' "$SERVER_ENV" 2>/dev/null | head -1 | strip)
[ -n "$KEY" ] || fail "no SHMEM_API_KEY in $SERVER_ENV"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"shmem-healthcheck","version":"1"}}}'
mcp_post() { # url session-id body
  curl -sS -m 20 -X POST "$1" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" ${2:+-H "Mcp-Session-Id: $2"} -d "$3" 2>&1
}

# 1. service
if systemctl --user is-active --quiet nanoclaw-shmem; then note "nanoclaw-shmem.service active"
else fail "nanoclaw-shmem.service is NOT active (systemctl --user status nanoclaw-shmem)"; fi

# 2. server handshake + a real tool call
if [ -n "$KEY" ]; then
  hdrs=$(curl -sS -m 10 -D - -o /dev/null -X POST "$HOST_URL" -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$INIT" 2>&1)
  code=$(printf '%s\n' "$hdrs" | awk 'NR==1{print $2}')
  sid=$(printf '%s\n' "$hdrs" | awk 'tolower($1)=="mcp-session-id:"{print $2}' | tr -d '\r')
  if [ "$code" != "200" ]; then
    fail "server initialize at $HOST_URL → HTTP ${code:-no response} ($(printf '%s' "$hdrs" | head -c 120 | tr '\n' ' '))"
  else
    mcp_post "$HOST_URL" "$sid" '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
    t0=$(date +%s%N)
    resp=$(mcp_post "$HOST_URL" "$sid" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"recall_memory","arguments":{"query":"shmem healthcheck","max_facts":3}}}')
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
    if printf '%s' "$resp" | grep -q '"result"' && ! printf '%s' "$resp" | grep -q '"isError":true'; then
      note "server recall_memory OK (${ms}ms)"
    else
      fail "server recall_memory failed: $(printf '%s' "$resp" | head -c 200 | tr '\n' ' ')"
    fi
  fi
fi

# 3. DB config per group, plus the materialized container.json for groups that
#    have a container running right now (the file is rewritten at spawn, so for
#    an idle group it is just the last spawn's snapshot, not the live config).
mapfile -t containers < <(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^ncl-')
live_groups=""
for c in "${containers[@]}"; do
  sess=${c##*-sess-}; d=$(ls -d "$REPO"/data/v2-sessions/*/sess-"$sess" 2>/dev/null | head -1)
  [ -n "$d" ] && live_groups+="$(basename "$(dirname "$d")"),"
done
while IFS=$'\t' read -r kind text; do
  [ -z "${kind:-}" ] && continue
  if [ "$kind" = FAIL ]; then fail "$text"; else note "$text"; fi
done < <(python3 - "$REPO/data/v2.db" "$REPO/groups" "$CONTAINER_URL" "$live_groups" <<'PY'
import json, os, sqlite3, sys
db, groups, want, live = sys.argv[1:]
live = set(filter(None, live.split(",")))
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = list(con.execute("select g.id, g.name, g.folder, c.mcp_servers from agent_groups g join container_configs c on c.agent_group_id = g.id"))
except Exception as e:
    print(f"FAIL\tcannot read central DB {db}: {e}"); sys.exit(0)
for gid, name, folder, mcp in rows:
    try: s = json.loads(mcp or "{}").get("shmem")
    except Exception as e: print(f"FAIL\t{name}: mcp_servers is not valid JSON ({e})"); continue
    if not s: continue  # group deliberately has no shmem
    if s.get("url") != want:
        print(f"FAIL\t{name}: DB shmem url is {s.get('url')!r}, must be {want!r}")
    else:
        print(f"NOTE\t{name}: DB shmem url OK")
    mat = os.path.join(groups, folder, "container.json")
    if gid not in live or not os.path.exists(mat): continue
    try: m = (json.load(open(mat)).get("mcpServers") or {}).get("shmem")
    except Exception as e: print(f"FAIL\t{name}: {mat} unreadable ({e})"); continue
    if not m:
        print(f"FAIL\t{name}: materialized container.json has NO shmem server — host dropped it at spawn (grep 'Dropping invalid stored MCP server' logs/nanoclaw.error.log)")
    elif m.get("url") != want:
        print(f"FAIL\t{name}: materialized shmem url is {m.get('url')!r}")
    else:
        print(f"NOTE\t{name}: materialized container.json shmem OK")
PY
)

# 4. running containers reach the server through their own env
if [ "${#containers[@]}" -eq 0 ]; then
  note "no agent container running — in-container probe skipped"
elif [ -n "$KEY" ]; then
  for c in "${containers[@]}"; do
    out=$(docker exec -e KEY="$KEY" -e INIT="$INIT" -e URL="$CONTAINER_URL" "$c" bash -c '
      case ",${NO_PROXY:-}," in *,host.docker.internal,*) ;; *) echo NOPROXY_MISSING ;; esac
      curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST "$URL" -H "Authorization: Bearer $KEY" \
        -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$INIT"' 2>&1)
    case "$out" in *NOPROXY_MISSING*) fail "$c: NO_PROXY lacks host.docker.internal — shmem traffic would go through the OneCLI proxy" ;; esac
    code=${out##*$'\n'}; code=${code: -3}
    if [ "$code" = "200" ]; then note "$c: in-container shmem initialize OK"
    else fail "$c: in-container shmem initialize → HTTP ${code:-none} ($(printf '%s' "$out" | head -c 120 | tr '\n' ' '))"; fi
  done
fi

# ---- state, alerting, log --------------------------------------------------
now=$(date +%s); stamp=$(date '+%Y-%m-%d %H:%M %Z')
status=ok; [ "${#fails[@]}" -gt 0 ] && status=fail
read -r prev_status prev_alert prev_since < <(python3 - "$STATE" <<'PY'
import json, sys
try: s = json.load(open(sys.argv[1]))
except Exception: s = {}
print(s.get("status", "unknown"), int(s.get("last_alert", 0)), int(s.get("since", 0)))
PY
)
since=$now; [ "$status" = "$prev_status" ] && [ "$prev_since" -gt 0 ] && since=$prev_since

msg=""
if [ "$status" = fail ]; then
  if [ "$prev_status" != fail ] || [ $((now - prev_alert)) -ge "$REALERT_SECS" ]; then
    msg="❌ shmem health check FAILED — $(hostname) $stamp"$'\n'
    for f in "${fails[@]}"; do msg+="• $f"$'\n'; done
    [ "$prev_status" = fail ] && msg+="(down since $(date -d "@$since" '+%Y-%m-%d %H:%M'))"$'\n'
    msg+="Runbook: docs/LOCAL.md → shmem health check"
  fi
elif [ "$prev_status" = fail ]; then
  msg="✅ shmem health check recovered — $(hostname) $stamp"$'\n'"$(printf '• %s\n' "${notes[@]}")"
elif [ "$NOTIFY_OK" = 1 ]; then
  msg="✅ shmem health check OK — $(hostname) $stamp"$'\n'"$(printf '• %s\n' "${notes[@]}")"
fi

alerted=0
if [ -n "$msg" ]; then
  TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$REPO/.env" 2>/dev/null | head -1 | strip)
  if [ -z "$TOKEN" ]; then echo "shmem-healthcheck: cannot alert — no TELEGRAM_BOT_TOKEN in $REPO/.env" >&2
  else
    rc=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot$TOKEN/sendMessage" \
      --data-urlencode "chat_id=$CHAT_ID" --data-urlencode "text=$msg" 2>&1)
    if [ "$rc" = "200" ]; then alerted=1; else echo "shmem-healthcheck: telegram sendMessage → $rc" >&2; fi
  fi
fi

mkdir -p "$(dirname "$STATE")" "$(dirname "$LOG")"
python3 - "$STATE" "$status" "$now" "$since" "$([ $alerted = 1 ] && echo "$now" || echo "$prev_alert")" "${fails[@]}" <<'PY'
import json, sys
path, status, now, since, last_alert, *fails = sys.argv[1:]
json.dump({"status": status, "checked_at": int(now), "since": int(since), "last_alert": int(last_alert), "fails": fails}, open(path, "w"), indent=1)
PY
printf '%s %s%s%s\n' "$(date -Is)" "$status" "$([ $alerted = 1 ] && echo ' [alerted]')" "$(printf ' | %s' "${fails[@]}")" >> "$LOG"

[ "$VERBOSE" = 1 ] && echo "status: $status"
[ "$status" = ok ]
