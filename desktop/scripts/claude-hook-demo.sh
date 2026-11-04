#!/usr/bin/env bash
# Sends sample Claude Code hook payloads to a running SMOI, so you can watch each reaction.
# Uses made-up session ids and no real prompt text.
#
#   SMOI_HOOK_SECRET=... bash desktop/scripts/claude-hook-demo.sh [short|long|waiting|parallel|bad]
#
# "long" can't wait 3 real minutes, so set "Celebrate runs of at least" to 0 in Settings first
# (or wait it out with SMOI_DEMO_WAIT=180).
set -u
PORT="${SMOI_HOOK_PORT:-47821}"
URL="http://127.0.0.1:$PORT/claude"
: "${SMOI_HOOK_SECRET:?Set SMOI_HOOK_SECRET to the same value SMOI was started with}"

send() { # route hook session [secret]
  local secret="${4:-$SMOI_HOOK_SECRET}"
  local code
  code=$(printf '{"session_id":"%s","hook_event_name":"%s","prompt":"demo only"}' "$3" "$2" |
    curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H "Content-Type: application/json" \
      -H "X-SMOI-Hook-Secret: $secret" --data-binary @- "$URL/$1")
  echo "$1 ($3): HTTP $code"
}

case "${1:-long}" in
  short)    send start UserPromptSubmit demo-short; sleep 2; send done Stop demo-short
            echo "Expect: nothing (the run was shorter than the threshold)." ;;
  long)     send start UserPromptSubmit demo-long; sleep "${SMOI_DEMO_WAIT:-2}"; send done Stop demo-long
            echo "Expect: celebrating frog and a lavender bubble with the duration (threshold 0, or SMOI_DEMO_WAIT=180)." ;;
  waiting)  send waiting Notification demo-wait; send waiting Notification demo-wait
            echo "Expect: attention frog and ONE pink bubble (the repeat is collapsed)." ;;
  parallel) send start UserPromptSubmit demo-a; send start UserPromptSubmit demo-b
            sleep "${SMOI_DEMO_WAIT:-2}"; send done Stop demo-b; send done Stop demo-a; send done Stop demo-a
            echo "Expect: two celebrations (threshold 0), none for the duplicate done." ;;
  bad)      send done Stop demo-bad wrong-secret
            printf 'not json' | curl -s -o /dev/null -w 'malformed: HTTP %{http_code}\n' -m 2 -X POST \
              -H "X-SMOI-Hook-Secret: $SMOI_HOOK_SECRET" --data-binary @- "$URL/start"
            send done Stop never-started
            echo "Expect: 401, 400, 204, and no reaction from the frog." ;;
  *) echo "usage: $0 [short|long|waiting|parallel|bad]"; exit 1 ;;
esac
