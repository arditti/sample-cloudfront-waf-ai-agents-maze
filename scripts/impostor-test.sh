#!/usr/bin/env bash
# AI Maze — good-bot impostor scenarios against a DEPLOYED stack.
#
#   ./scripts/impostor-test.sh [stack-name]        # default: AiMazePoc
#
# Proves the UnverifiedGoodBotDecoyDirective WAF rule: a request that CLAIMS a
# good-bot category (e.g. Googlebot's User-Agent) but does not carry Bot
# Control's bot:verified label must be routed into the maze, while a browser
# on the same URL keeps getting the real page. Lives outside e2e-test.sh only
# because the two were written on parallel branches; fold it in when merged.
#
# What this CANNOT test: a genuinely verified good bot (bot:verified requires
# passing Bot Control's reverse-DNS/host validation, which only the real
# Googlebot's IPs can). That half of the rule rides on the label's absence
# here and AWS's verification on the real crawler's side.
#
# Requirements: awscli v2 with credentials for the stack's account, curl.
# Read-only apart from the traffic it generates. Exits non-zero on failure.

set -uo pipefail

STACK="${1:-AiMazePoc}"
REGION="${AWS_REGION:-us-east-1}"

# A good-bot UA from an IP that cannot pass Google's reverse DNS — the impostor.
IMPOSTOR_UA='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
# A plain browser: must NEVER be mazed.
HUMAN_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
# A self-declared tool: gets a bot category (http_library), but not one this
# rule covers — proves the match is scoped to impersonatable good-bot
# categories, not "any unverified bot".
TOOL_UA='curl/8.7.1'

# Generation is async; how long to wait for a decoy before settling for the
# miss-action outcome as proof.
GEN_WAIT_SECONDS="${GEN_WAIT_SECONDS:-300}"

pass=0; fail=0

ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }; }
need aws; need curl

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

DOMAIN="$(out DistributionDomainName)"
[ -n "$DOMAIN" ] && [ "$DOMAIN" != "None" ] || { echo "stack $STACK has no DistributionDomainName output" >&2; exit 2; }
URL="https://${DOMAIN}/"

code_ua() { curl -s -o /dev/null -w '%{http_code}' -m 30 -A "$1" "$URL"; }
body_ua() { curl -s -m 30 -A "$1" "$URL"; }

head_ "Good-bot impostor scenarios against $STACK ($URL)"

# --- 1. Baseline: a browser gets the real page. -----------------------------
human_body="$(body_ua "$HUMAN_UA")"
human_code="$(code_ua "$HUMAN_UA")"
if [ "$human_code" = "200" ] && [ -n "$human_body" ] && ! printf '%s' "$human_body" | grep -qi 'noindex'; then
  ok "browser UA gets the real page (200, no noindex)"
else
  no "browser UA baseline broken (code=$human_code) — cannot judge the rest"
  exit 1
fi

# --- 2. The impostor is mazed. -----------------------------------------------
# Before a decoy exists the directive still applies: miss-action=block answers
# with a non-200. Either outcome (block, or a decoy body that differs from the
# real page) proves the WAF rule fired; the real page verbatim proves it did not.
deadline=$(( $(date +%s) + GEN_WAIT_SECONDS ))
impostor_result=""
while :; do
  bot_code="$(code_ua "$IMPOSTOR_UA")"
  if [ "$bot_code" != "200" ]; then
    impostor_result="blocked ($bot_code) pending decoy generation"
  else
    bot_body="$(body_ua "$IMPOSTOR_UA")"
    if [ "$bot_body" = "$human_body" ]; then
      impostor_result=""   # got the real page — the gap
    else
      impostor_result="served a decoy (200, body differs from the real page)"
      break
    fi
  fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 15
done
if [ -n "$impostor_result" ]; then
  ok "Googlebot UA from an unverified IP: $impostor_result"
else
  no "Googlebot UA from an unverified IP was served the REAL page — impostor gap open"
fi

# --- 3. Scope: a non-good-bot category is untouched by this rule. -------------
tool_body="$(body_ua "$TOOL_UA")"
if [ "$tool_body" = "$human_body" ]; then
  ok "http-library UA (curl) still gets the real page — match is scoped to good-bot categories"
else
  no "http-library UA no longer gets the real page — rule matches too broadly"
fi

# --- 4. Highest severity: the maze must not leak to people. -------------------
# Re-fetch as a browser AFTER the impostor traffic: the decoy must not have
# polluted the cache entry a person is served from.
human_after="$(body_ua "$HUMAN_UA")"
if [ "$human_after" = "$human_body" ]; then
  ok "browser UA still gets the identical real page after impostor traffic"
else
  no "browser UA response CHANGED after impostor traffic — possible decoy leak to humans"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
