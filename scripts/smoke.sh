#!/usr/bin/env bash
# End-to-end smoke test for the Oscar web app's contract with the backend.
#
# Exercises the flows a browser actually performs, in order, against a running
# backend with WEB_AUTH_ENFORCE=1 — the configuration the web app is built for.
# Compilation proves nothing about any of this.
#
#   BASE=http://127.0.0.1:8099 ./scripts/smoke.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8099}"
JQ="$(dirname "$0")/jqp"
PASS=0; FAIL=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
# NOT named `head`: that shadows /usr/bin/head, and any `| head -c N`
# elsewhere in the script then prints a banner instead of truncating.
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# check <label> <wanted-status> <curl args…>
#
# Runs the request HERE rather than taking a status as an argument. The previous
# shape passed `"$(curl …)"` into a comparison function; nesting a command
# substitution containing double-quoted arguments inside an argument list split it
# into extra words, so the function received the status in BOTH the actual and
# wanted positions and every assertion passed unconditionally — including the
# authorization ones. A test that cannot fail is worse than no test at all.
check() {
  local label="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' -m 25 "$@")
  if [ "$got" = "$want" ]; then ok "$label ($got)"
  else bad "$label — got $got, wanted $want"; fi
}

body() { curl -s -m 25 "$@"; }

section "0 · reachability"
check "GET /health" 200 "$BASE/health"

section "1 · sign in"
LOGIN=$(body -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(printf '%s' "$LOGIN" | "$JQ" token)
UID_=$(printf '%s' "$LOGIN"  | "$JQ" id)
[ -n "$TOKEN" ] && [ "$TOKEN" != "None" ] \
  && ok "login returned a bearer token" || bad "login returned NO token: $LOGIN"
[ -n "$UID_" ] && ok "login returned user id $UID_" || bad "no user id in $LOGIN"

AUTH=(-H "Authorization: Bearer $TOKEN")

section "2 · the IDOR guard (the reason the token exists)"
# Hoisted: $(( )) nested inside an escaped-quote payload inside $( )
# across a line continuation reaches curl malformed.
OTHER=$((UID_+1))
check "GET /tasks/\$me with token" 200 "${AUTH[@]}" "$BASE/tasks/$UID_"
check "GET /tasks/\$me WITHOUT token" 401 "$BASE/tasks/$UID_"
check "GET someone else's tasks" 403 "${AUTH[@]}" "$BASE/tasks/$OTHER"
check "GET someone else's notes" 403 "${AUTH[@]}" "$BASE/users/$OTHER/notes"
check "GET notes?user_id=other" 403 "${AUTH[@]}" "$BASE/notes/1?user_id=$OTHER"
check "garbage token" 401 -H 'Authorization: Bearer nope' "$BASE/tasks/$UID_"
check "POST /chat claiming another user" 403 -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"user_id\":$OTHER,\"message\":\"hi\"}" "$BASE/chat"
check "POST /chat/stream claiming another user" 403 -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"user_id\":$OTHER,\"message\":\"hi\"}" "$BASE/chat/stream"
check "POST /items claiming another user" 403 -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"user_id\":$OTHER,\"title\":\"x\",\"item_type\":\"task\"}" "$BASE/items"
check "/health stays public" 200 "$BASE/health"
check "/auth/login stays public" 422 -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{}'

section "3 · tasks"
check "list tasks" 200 "${AUTH[@]}" "$BASE/tasks/$UID_"
NEW=$(body -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
      -d "{\"user_id\":$UID_,\"title\":\"[webapp smoke] delete me\",\"item_type\":\"task\",\"due_at\":\"$DUE\",\"priority\":\"low\"}" \
      "$BASE/items")
TASK_ID=$(printf '%s' "$NEW" | "$JQ" id)
[ -n "$TASK_ID" ] && ok "created task $TASK_ID" || bad "create failed: $NEW"

if [ -n "$TASK_ID" ]; then
  check "comment on it" 200 -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"body":"[webapp smoke] a comment"}' "$BASE/users/$UID_/tasks/$TASK_ID/comments"
  check "read the thread" 200 "${AUTH[@]}" "$BASE/users/$UID_/tasks/$TASK_ID/comments"
  check "complete it (the /complete route, not PATCH status)" 200 -X PATCH "${AUTH[@]}" "$BASE/items/$TASK_ID/complete?user_id=$UID_"
  # status and user_id are QUERY params here — a JSON body returns 422.
  check "reopen it via /status" 200 -X PATCH "${AUTH[@]}" "$BASE/items/$TASK_ID/status?user_id=$UID_&status=pending"
fi

section "4 · notes + plan my day"
NOTE=$(body -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
       -d '{"content":"[webapp smoke] I start work at 9 and keep Fridays free."}' \
       "$BASE/users/$UID_/notes")
NOTE_ID=$(printf '%s' "$NOTE" | "$JQ" id)
[ -n "$NOTE_ID" ] && ok "created note $NOTE_ID" || bad "note create failed: $NOTE"
check "list notes" 200 "${AUTH[@]}" "$BASE/users/$UID_/notes"
PLAN=$(body -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{}' \
       "$BASE/users/$UID_/notes/plan-day")
printf '%s' "$PLAN" | grep -q '"tasks"' \
  && ok "plan-day returned suggestions (persists nothing)" \
  || bad "plan-day: $PLAN"

section "5 · meetings / calendar"
check "GET /meetings?all=true" 200 "${AUTH[@]}" "$BASE/meetings/$UID_?all=true"
check "GET /calendar/events" 200 "${AUTH[@]}" "$BASE/calendar/events?user_id=$UID_"

section "6 · notifications"
check "GET notifications" 200 "${AUTH[@]}" "$BASE/notifications/$UID_"
check "POST read-all" 200 -X POST "${AUTH[@]}" "$BASE/notifications/$UID_/read-all"

section "7 · assistant metadata"
check "GET /assistant/suggestions" 200 "${AUTH[@]}" "$BASE/assistant/suggestions?user_id=$UID_"
check "GET /assistant/business" 200 "${AUTH[@]}" "$BASE/assistant/business?user_id=$UID_"

section "8 · chat sessions"
# user_id is a QUERY param on this route, not a body field.
SESS=$(body -X POST "${AUTH[@]}" "$BASE/chat/sessions?user_id=$UID_&title=%5Bwebapp+smoke%5D")
SID=$(printf '%s' "$SESS" | "$JQ" session_id)
[ -n "$SID" ] && ok "opened session $SID" || bad "session create failed: $SESS"
check "list sessions" 200 "${AUTH[@]}" "$BASE/chat/sessions?user_id=$UID_"
[ -n "$SID" ] && check "read history" 200 "${AUTH[@]}" "$BASE/chat/sessions/$SID/messages?user_id=$UID_"

section "9 · /chat/stream without a socket must decline, not hang"
STREAM=$(body -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
         -d "{\"user_id\":$UID_,\"message\":\"hi\",\"session_id\":${SID:-0}}" "$BASE/chat/stream")
printf '%s' "$STREAM" | grep -q '"streaming": *false' \
  && ok "declined with streaming:false (client falls back to /chat)" \
  || bad "expected streaming:false with no socket, got: $STREAM"

section "10 · cleanup"
[ -n "${TASK_ID:-}" ] && check "delete the smoke task" 200 -X DELETE "${AUTH[@]}" "$BASE/items/$TASK_ID?user_id=$UID_"
[ -n "${NOTE_ID:-}" ] && check "delete the smoke note" 200 -X DELETE "${AUTH[@]}" "$BASE/notes/$NOTE_ID?user_id=$UID_&hard=true"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
