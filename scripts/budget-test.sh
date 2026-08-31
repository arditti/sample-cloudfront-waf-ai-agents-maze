#!/usr/bin/env bash
# AI Maze — proves the generation admission budget HOLDS, live (threat
# model M2).
#
# Needs its own TEST-SIZED stack: a cap the main e2e suite could exhaust would
# break every earlier scenario of that suite, so this cannot be a scenario
# there. Deploy an isolated copy with one admission per five-minute window,
# then point this script at it:
#
#   cd infra && GEN_BUDGET_PER_WINDOW=1 GEN_BUDGET_WINDOW_SECONDS=300 \
#     MAZE_STACK_SUFFIX=Budget npx cdk deploy
#   ./scripts/budget-test.sh AiMazePocBudget
#
# Three assertions, in crawl order: the first fresh context of the window is
# admitted; the second is dropped with a budget_exhausted record and no
# admission mark; and the NEXT window admits the dropped context after all —
# a ceiling, not a lockout.
#
# Requirements: awscli v2 with credentials for the stack's account, curl.
# Read-only apart from the traffic it generates.

set -uo pipefail

STACK="${1:-AiMazePocBudget}"
REGION="${AWS_REGION:-us-east-1}"
BOT_UA='Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)'

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }; }
need aws; need curl

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else sha256sum | cut -d' ' -f1; fi
}

# Mirrors contextKeyForPath in services/edge/maze-viewer.js (same as e2e-test.sh).
ctx_key() {
  local p="$1"
  [ "${#p}" -gt 1 ] && p="${p%/}"
  [ -z "$p" ] && p="/"
  printf 'v1:%s' "$p" | sha256 | cut -c1-20
}

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

admit_mark() { # ctx -> its admission window, or empty
  local v
  v="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"ADMIT#$1\"},\"SK\":{\"S\":\"ADMIT\"}}" \
    --query 'Item.window.N' --output text 2>/dev/null)"
  [ "$v" = "None" ] && v=""
  echo "$v"
}

poll_admit() { # ctx tries -> echoes the admission window when it appears
  local i v
  for i in $(seq 1 "$2"); do
    sleep 5
    v="$(admit_mark "$1")"
    if [ -n "$v" ]; then echo "$v"; return 0; fi
  done
  return 1
}

ask() { curl -s -o /dev/null -A "$BOT_UA" -m 30 "$BASE$1"; }

head_ "Resolving $STACK in $REGION"
DOMAIN="$(out DistributionDomainName)"
TABLE="$(out SnapshotTableName)"
PARSER_LOG="$(out ParserLogGroupName)"
CAP="$(out GenBudgetPerWindow)"
WIN="$(out GenBudgetWindowSeconds)"
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "None" ]; then
  echo "could not read stack outputs for $STACK — is it deployed?" >&2
  exit 2
fi
if [ "${CAP:-0}" != "1" ] || [ -z "$WIN" ] || [ "$WIN" = "None" ] || [ "$WIN" -gt 300 ]; then
  echo "this stack's budget (${CAP:-none} per ${WIN:-?}s) is not test-sized; deploy with" >&2
  echo "GEN_BUDGET_PER_WINDOW=1 GEN_BUDGET_WINDOW_SECONDS=300 (see header)" >&2
  exit 2
fi
BASE="https://$DOMAIN"
echo "  distribution: $DOMAIN"
echo "  budget:       $CAP per ${WIN}s"

TS="$(date +%s)"
START_MS="$(( TS * 1000 ))"

# Fresh, never-before-asked paths. Their generations will 404-fail later and
# back off — irrelevant here: admission happens BEFORE generation, which is the
# point (a doomed path still costs the attempt, so it is billed like any other).
A="/budget-$TS-a"; A_CTX="$(ctx_key "$A")"
B="/budget-$TS-b"; B_CTX="$(ctx_key "$B")"

# ---------------------------------------------------------------------------
head_ "1. The first fresh context of the window is admitted"
# ---------------------------------------------------------------------------
ask "$A"
if a_win="$(poll_admit "$A_CTX" 24)"; then
  ok "$A admitted (window $a_win)"
else
  no "$A never received an ADMIT mark — is the parser deployed with the budget?"
  printf '\n  1 passed, %d failed (scenarios 2-3 need scenario 1)\n' "$fail"
  exit 1
fi

# Scenario 2 must land in a window that is ALREADY spent. If polling ate most of
# this one, roll into the next and spend that instead.
now="$(date +%s)"
rem="$(( a_win + WIN - now ))"
if [ "$rem" -lt 60 ]; then
  [ "$rem" -gt 0 ] && sleep "$(( rem + 5 ))"
  R="/budget-$TS-refill"
  ask "$R"
  if a_win="$(poll_admit "$(ctx_key "$R")" 24)"; then
    echo "  (window rolled during polling; $R spent window $a_win instead)"
  else
    no "could not spend the fresh window with $R"
  fi
fi

# ---------------------------------------------------------------------------
head_ "2. The next fresh context is dropped, loudly"
# ---------------------------------------------------------------------------
ask "$B"
sleep 30

if [ -n "$(admit_mark "$B_CTX")" ]; then
  no "$B was admitted although the window was spent"
else
  ok "$B has no ADMIT mark: nothing downstream of the parser woke for it"
fi

exhausted="$(aws logs filter-log-events --log-group-name "$PARSER_LOG" --region "$REGION" \
  --start-time "$START_MS" --filter-pattern '"budget_exhausted"' \
  --query 'events[].message' --output text 2>/dev/null)"
if printf '%s' "$exhausted" | grep -q "$B_CTX"; then
  ok "the drop is on the record: budget_exhausted names $B_CTX (feeds the GenBudgetExhausted metric)"
else
  no "no budget_exhausted record for $B_CTX — a silent ceiling reads as 'no crawlers'"
fi

# ---------------------------------------------------------------------------
head_ "3. The next window admits the dropped context — a ceiling, not a lockout"
# ---------------------------------------------------------------------------
now="$(date +%s)"
wait_s="$(( a_win + WIN - now + 10 ))"
[ "$wait_s" -gt 0 ] && sleep "$wait_s"
ask "$B"

if b_win="$(poll_admit "$B_CTX" 24)"; then
  if [ "$b_win" -gt "$a_win" ]; then
    ok "$B admitted in a LATER window ($a_win -> $b_win)"
  else
    no "$B carries window $b_win, not later than $a_win — the counter key is wrong"
  fi
else
  no "$B still locked out after the window rolled over"
fi

# ---------------------------------------------------------------------------
head_ "Summary"
# ---------------------------------------------------------------------------
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
