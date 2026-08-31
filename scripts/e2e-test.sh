#!/usr/bin/env bash
# AI Maze — end-to-end scenario suite against a DEPLOYED stack.
#
#   ./scripts/e2e-test.sh [stack-name]        # default: AiMazePoc
#
# Every verification scenario is exercised here, in the
# order a real crawl would hit them: pass-through, detection, generation,
# serving, attribution, and the negative paths that must NOT produce a decoy.
#
# Requirements: awscli v2 with credentials for the stack's account, curl, and
# either shasum or sha256sum. Read-only apart from the traffic it generates.
#
# Exits non-zero if any scenario fails. Prints PASS/FAIL per scenario; never
# prints the ingest secret.

set -uo pipefail

STACK="${1:-AiMazePoc}"
REGION="${AWS_REGION:-us-east-1}"

BOT_UA='Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)'
HUMAN_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
INGEST_HEADER='x-maze-ingest'

# Generation is async: ingest + Opus 5 + stage + seal + publish + KVS promote.
GEN_WAIT_SECONDS="${GEN_WAIT_SECONDS:-300}"

pass=0; fail=0; skip=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
skp()  { printf '  \033[33mSKIP\033[0m %s\n' "$1"; skip=$((skip+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }; }
need aws; need curl

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else sha256sum | cut -d' ' -f1; fi
}

# The edge function's context key: sha256("v1:" + normalized path), first 20 hex.
# Mirrors contextKeyForPath in services/edge/maze-viewer.js. The query string is
# deliberately excluded there, so it is excluded here too.
ctx_key() {
  local p="$1"
  [ "${#p}" -gt 1 ] && p="${p%/}"
  [ -z "$p" ] && p="/"
  printf 'v1:%s' "$p" | sha256 | cut -c1-20
}

out() { # stack output value by key
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

code() { curl -s -o /dev/null -w '%{http_code}' -m 30 "$@"; }
body() { curl -s -m 30 "$@"; }

# Is this response a decoy? Decoys carry no visible marker and (since the
# zero-width watermark was removed as a one-fetch tell) no invisible one either.
# The oracle is the beacon stylesheet every HTML decoy links in its head — the
# structural signature injectedHead() always emits, matched with the same shape
# assertNotOwnDecoy() keys on. A test that greps for a brand string would
# silently stop being able to fail.
is_decoy() { # file
  grep -qE '<link rel="stylesheet" href="[^"]*/wm/[a-f0-9]{8}\.css">' "$1" 2>/dev/null
}

# The page id of a decoy file: the 8-hex token of its beacon stylesheet. Empty
# when the file is not a decoy.
decoy_token() { # file
  grep -oE '<link rel="stylesheet" href="[^"]*/wm/[a-f0-9]{8}\.css">' "$1" 2>/dev/null \
    | grep -oE '[a-f0-9]{8}\.css' | head -1 | cut -d. -f1
}

head_ "Resolving $STACK in $REGION"
DOMAIN="$(out DistributionDomainName)"
TABLE="$(out SnapshotTableName)"
QUEUE="$(out GenQueueUrl)"
# Resolved once: several scenarios assert against the edge log, and a scenario that
# only learned the log group inside another scenario's branch would silently skip.
LOG_GROUP="$(out CffLogGroupName)"
# The edge log is the control plane now (only `decoy_needed`); everything queryable is on
# the CloudFront access record, written with cf.logCustomData.
ACCESS_LOG_GROUP="$(out AccessLogGroupName)"
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "None" ]; then
  echo "could not read stack outputs for $STACK — is it deployed?" >&2
  exit 2
fi
BASE="https://$DOMAIN"
echo "  distribution: $DOMAIN"
echo "  table:        $TABLE"

# The ingest secret lives in SSM (minted once by the IngestSecret custom
# resource). Needed only for scenario 2; never echoed.
INGEST_SECRET="$(aws ssm get-parameter --name "/ai-maze/$STACK/ingest-secret" \
  --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null)"

# ---------------------------------------------------------------------------
head_ "1. Normal visitor passes through untouched"
# ---------------------------------------------------------------------------
c="$(code -A "$HUMAN_UA" "$BASE/")"
[ "$c" = "200" ] && ok "GET / as a browser -> 200 real content" \
                 || no "GET / as a browser -> $c (expected 200)"

body -A "$HUMAN_UA" "$BASE/" > /tmp/lab-visitor-root
if is_decoy /tmp/lab-visitor-root; then
  no "a normal visitor was served DECOY content"
else
  ok "a normal visitor gets the real page"
fi

# ---------------------------------------------------------------------------
head_ "2. Ingestion is allowlisted, never mazed"
# ---------------------------------------------------------------------------
# This is the generator's own path: a bot-looking UA that would normally be
# labeled, plus the ingest header. AllowMazeIngest must terminate the
# WebACL before Bot Control runs. If this fails, the generator builds decoys
# from decoys.
if [ -z "$INGEST_SECRET" ] || [ "$INGEST_SECRET" = "None" ]; then
  skp "ingest secret not readable from SSM — cannot test the allowlist"
else
  # With the right header the response must be the REAL page: ingestion has to see
  # what a visitor sees, or the generator builds decoys from decoys.
  curl -s -A "$BOT_UA" -H "$INGEST_HEADER: $INGEST_SECRET" -m 30 -o /tmp/lab-ingest-body "$BASE/"
  if is_decoy /tmp/lab-ingest-body; then
    no "ingestion was served a DECOY — the WAF allowlist is not matching"
  else
    ok "bot UA + ingest header -> real content (WAF allowlist matches)"
  fi

  # A wrong value must NOT be allowlisted. The request is then an ordinary flagged
  # crawler, so the correct outcome is the maze (decoy in place), or 403 on a cold
  # context — anything except the real page.
  curl -s -A "$BOT_UA" -H "$INGEST_HEADER: not-the-secret" -m 30 -o /tmp/lab-wrong-body -w '%{http_code}' "$BASE/" > /tmp/lab-wrong-code
  wc="$(cat /tmp/lab-wrong-code)"
  if [ "$wc" = "403" ] || is_decoy /tmp/lab-wrong-body; then
    ok "bot UA + WRONG ingest header -> mazed or blocked ($wc), not allowlisted"
  else
    no "a wrong ingest header value received real content ($wc)"
  fi
fi

# ---------------------------------------------------------------------------
head_ "3. AI crawler on a cold context is detected and signals generation"
# ---------------------------------------------------------------------------
# Query string included on purpose: the logged URL must carry it, so the
# generator re-fetches the resource the crawler actually asked for.
PROBE_PATH='/'
PROBE_QS='?e2e=1'
curl -s -A "$BOT_UA" -m 30 -o /tmp/lab-cold-body -w '%{http_code}' "$BASE$PROBE_PATH$PROBE_QS" > /tmp/lab-cold-code
c="$(cat /tmp/lab-cold-code)"
if [ "$c" = "403" ]; then
  ok "GPTBot on a cold context -> 403 (WAF miss directive = block)"
elif [ "$c" = "200" ] && is_decoy /tmp/lab-cold-body; then
  ok "GPTBot -> 200 with a decoy in place (this context was already primed)"
else
  no "GPTBot on / -> $c (expected 403 cold, or 200-with-decoy if primed)"
fi

CTX="$(ctx_key "$PROBE_PATH")"
echo "  context key for $PROBE_PATH: $CTX"

# ---------------------------------------------------------------------------
head_ "4. Generation completes and seals a snapshot"
# ---------------------------------------------------------------------------
echo "  waiting up to ${GEN_WAIT_SECONDS}s for the pipeline (ingest -> Opus 5 -> seal -> publish)"
deadline=$(( $(date +%s) + GEN_WAIT_SECONDS ))
pointer=''
while [ "$(date +%s)" -lt "$deadline" ]; do
  pointer="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"CTX#$CTX\"},\"SK\":{\"S\":\"POINTER\"}}" \
    --query 'Item.appliedVersion.S' --output text 2>/dev/null)"
  [ -n "$pointer" ] && [ "$pointer" != "None" ] && break
  sleep 15
done

if [ -n "$pointer" ] && [ "$pointer" != "None" ]; then
  ok "snapshot published for ctx=$CTX version=$pointer"

  SNAP="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"CTX#$CTX\"},\"SK\":{\"S\":\"SNAP#$pointer\"}}" --output json 2>/dev/null)"

  arch="$(printf '%s' "$SNAP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Item"]["archetype"]["S"])' 2>/dev/null)"
  [ "$arch" = "html" ] && ok "archetype detected as 'html' for a document source" \
                       || no "archetype was '$arch' (expected 'html')"

  # The detection evidence proves it came from the content-type + model, not a path rule.
  det="$(printf '%s' "$SNAP" | python3 -c '
import json,sys
d=json.load(sys.stdin)["Item"].get("detect",{}).get("M",{})
print(d.get("via",{}).get("S",""), "|", d.get("contentType",{}).get("S",""), "|", d.get("confidence",{}).get("N",""))' 2>/dev/null)"
  case "$det" in
    *content-type+llm*) ok "detection evidence recorded: $det" ;;
    *)                  no "no detect evidence on the snapshot (got: '$det')" ;;
  esac

  # The ingested URL must be the absolute URL from the triggering event.
  su="$(printf '%s' "$SNAP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Item"].get("sourceUrl",{}).get("S",""))' 2>/dev/null)"
  case "$su" in
    https://*) ok "snapshot recorded the absolute ingested URL: $su" ;;
    *)         no "sourceUrl is not an absolute URL (got: '$su')" ;;
  esac
else
  no "no snapshot published for ctx=$CTX within ${GEN_WAIT_SECONDS}s"
  echo "  -> check the generator log group and the DLQ"
fi

# ---------------------------------------------------------------------------
head_ "5. A warm context is served a decoy IN PLACE, and visitors are not"
# ---------------------------------------------------------------------------
# The decoy replaces the response at the SAME url: no redirect, nothing in the
# response that hints a different artifact was substituted.
read -r st nred < <(curl -s -o /tmp/lab-bot-body -A "$BOT_UA" -m 30 -w '%{http_code} %{num_redirects}' "$BASE$PROBE_PATH")
if [ "$st" = "200" ] && [ "$nred" = "0" ]; then
  ok "GPTBot on a warm context -> 200 at the original URL, no redirect"
else
  no "GPTBot on a warm context -> status=$st redirects=$nred (expected 200 / 0)"
fi
is_decoy /tmp/lab-bot-body \
  && ok "the body served to the crawler is a decoy (beacon stylesheet present)" \
  || no "the crawler was served real content, not a decoy"
# And it must not be identifiable from the outside.
if grep -qE 'x-maze|data-dpid|maze-decoy|x_maze' /tmp/lab-bot-body; then
  no "the decoy announces itself with a visible marker"
else
  ok "the decoy carries no visible marker"
fi
# Nor from the inside: the zero-width watermark was removed because a packaged
# normalizer flagged it in ONE fetch (34 suspicious characters vs 0 on the real
# page). A fresh decoy must contain no format characters at all.
if python3 -c 'import sys; b=open("/tmp/lab-bot-body",encoding="utf-8",errors="replace").read(); sys.exit(1 if any(c in b for c in "\u200b\u200c\u200d\u2060\ufeff") else 0)'; then
  ok "the decoy carries zero zero-width characters (nothing for a normalizer to flag)"
else
  no "the decoy still contains zero-width characters — the watermark tell is back"
fi
grep -q 'noindex' /tmp/lab-bot-body && ok "decoy is noindex,nofollow" || no "decoy is missing robots noindex"

# THE important one: rewriting the uri must keep decoys in their own cache entries.
# If this fails, real people are being served decoys.
curl -s -A "$HUMAN_UA" -m 30 -o /tmp/lab-human-body "$BASE$PROBE_PATH"
if is_decoy /tmp/lab-human-body; then
  no "CACHE POISONED: an ordinary visitor was served decoy content"
else
  ok "an ordinary visitor still gets the real page (cache stays separated)"
fi

# ---------------------------------------------------------------------------
head_ "6. JSON endpoint gets a schema-isomorphic JSON decoy"
# ---------------------------------------------------------------------------
API_PATH='/api/products'
code -A "$BOT_UA" "$BASE$API_PATH" >/dev/null   # prime
API_CTX="$(ctx_key "$API_PATH")"
api_ver="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
  --key "{\"PK\":{\"S\":\"CTX#$API_CTX\"},\"SK\":{\"S\":\"POINTER\"}}" \
  --query 'Item.appliedVersion.S' --output text 2>/dev/null)"
if [ -n "$api_ver" ] && [ "$api_ver" != "None" ]; then
  a="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"CTX#$API_CTX\"},\"SK\":{\"S\":\"SNAP#$api_ver\"}}" \
    --query 'Item.archetype.S' --output text 2>/dev/null)"
  [ "$a" = "json" ] && ok "archetype detected as 'json' from application/json" \
                    || no "archetype for $API_PATH was '$a' (expected 'json')"
  body -A "$BOT_UA" "$BASE$API_PATH" > /tmp/lab-api-bot
  python3 -c 'import json,sys; json.load(open("/tmp/lab-api-bot"))' 2>/dev/null \
    && ok "JSON decoy is valid JSON" || no "JSON decoy did not parse"
  grep -q 'x_maze' /tmp/lab-api-bot \
    && no "JSON decoy carries an out-of-band key (breaks schema isomorphism)" \
    || ok "JSON decoy adds no extra key"
  # Traceability for JSON text comes from the snapshot canary set; the payload
  # itself carries only the beacon, riding in its own URL-valued fields.
  body -A "$HUMAN_UA" "$BASE$API_PATH" > /tmp/lab-api-human
  # These two used to print their own PASS/FAIL from inside python, which never
  # touched the counters — a real failure would have been printed and then ignored.
  if python3 -c 'import json,sys; sys.exit(0 if json.dumps(json.load(open("/tmp/lab-api-bot")),sort_keys=True) != json.dumps(json.load(open("/tmp/lab-api-human")),sort_keys=True) else 1)'; then
    ok "the crawler and a visitor get different catalogues"
  else
    no "the crawler and a visitor got the SAME catalogue (no decoy substituted)"
  fi
  if python3 -c 'import json,sys; sys.exit(0 if set(json.load(open("/tmp/lab-api-bot")).keys()) == set(json.load(open("/tmp/lab-api-human")).keys()) else 1)'; then
    ok "JSON decoy keeps the real schema"
  else
    no "JSON decoy schema drifted from the real one"
  fi

  # JSON has no renderer to exploit, so its beacon has to live in the payload's own
  # schema: an existing image/url VALUE is repointed (never a new key). Whether that
  # is possible depends on the schema, so the snapshot records what was done and this
  # asserts against that rather than assuming coverage.
  api_beacon="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"CTX#$API_CTX\"},\"SK\":{\"S\":\"SNAP#$api_ver\"}}" \
    --query 'Item.beacon.M.token.S' --output text 2>/dev/null)"
  if [ -z "$api_beacon" ] || [ "$api_beacon" = "None" ]; then
    skp "this payload has no URL-valued field, so the JSON decoy carries canaries only"
  else
    # The served payload's image beacon must carry the exact token the snapshot
    # recorded — a beacon whose token drifted could not be traced back to a decoy.
    if node -e "
      const raw = require('node:fs').readFileSync('/tmp/lab-api-bot', 'utf8');
      const img = JSON.stringify(JSON.parse(raw)).match(/\/wm\/([a-f0-9]+)\.svg/);
      process.exit(img && img[1] === '$api_beacon' ? 0 : 1);
    " 2>/dev/null; then
      ok "JSON decoy carries its image beacon on the snapshot's token ($api_beacon)"
    else
      no "the JSON decoy's image beacon is missing or disagrees with the snapshot token"
    fi
    read -r st ct < <(curl -s -o /dev/null -A "$BOT_UA" -m 30 -H "Referer: $BASE$API_PATH" \
      -w '%{http_code} %{content_type}' "$BASE/wm/$api_beacon.svg")
    case "$st$ct" in
      200*image/svg+xml*) ok "the image beacon serves a real image (a client displaying the data fetches it)" ;;
      *) no "the image beacon -> status=$st type=$ct (expected 200 image/svg+xml)" ;;
    esac
  fi
else
  skp "$API_PATH not generated yet — re-run to verify the json archetype"
fi

# ---------------------------------------------------------------------------
head_ "7. Client-rendered app proves the renderer executes JavaScript"
# ---------------------------------------------------------------------------
SPA_PATH='/app/index.html'
code -A "$BOT_UA" "$BASE$SPA_PATH" >/dev/null   # prime
SPA_CTX="$(ctx_key "$SPA_PATH")"
spa_ver="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
  --key "{\"PK\":{\"S\":\"CTX#$SPA_CTX\"},\"SK\":{\"S\":\"POINTER\"}}" \
  --query 'Item.appliedVersion.S' --output text 2>/dev/null)"
if [ -n "$spa_ver" ] && [ "$spa_ver" != "None" ]; then
  body -A "$BOT_UA" "$BASE$SPA_PATH" > /tmp/lab-spa-bot
  S="$(cat /tmp/lab-spa-bot)"
  if ! is_decoy /tmp/lab-spa-bot; then
    no "the crawler was served the real SPA, not a decoy"
  # The real app renders a product grid client-side. A decoy built from an
  # unexecuted shell would not carry those class names.
  elif printf '%s' "$S" | grep -qE 'product-(grid|card)|class="[^"]*card'; then
    ok "SPA decoy mirrors the HYDRATED DOM (grid/card structure present)"
  else
    no "SPA decoy has no hydrated structure — renderer may not have executed JS"
  fi
else
  skp "$SPA_PATH not generated yet — re-run to verify structural isomorphism"
fi

# ---------------------------------------------------------------------------
head_ "8. The corpus is not addressable"
# ---------------------------------------------------------------------------
# HUMAN_UA on purpose: with a bot UA these probes are themselves flagged, and the
# edge would log decoy_needed for the /corpus/... path — enqueueing a bogus
# generation whose ingest then 403s. The assertion is about the missing route, not
# about bot detection, so keep the test from polluting the pipeline it measures.
c="$(code -A "$HUMAN_UA" "$BASE/corpus/$CTX/${pointer:-v1}/decoy/index.html")"
[ "$c" = "403" ] && ok "direct /corpus/... -> 403 (no bypass of the signed gate)" \
                 || no "direct /corpus/... -> $c (expected 403)"

# A guessed corpus key for a version that does not exist must not leak either.
c="$(code -A "$HUMAN_UA" "$BASE/corpus/$CTX/v999/decoy/index.html")"
[ "$c" = "403" ] && ok "unknown corpus version -> 403" \
                 || no "unknown corpus version -> $c (expected 403)"

# ---------------------------------------------------------------------------
head_ "9. Negative paths fail loudly instead of generating junk"
# ---------------------------------------------------------------------------
# Unsupported media has no decoy archetype (no structure to be isomorphic to),
# so the message must fail and retry to the DLQ rather than produce a decoy.
ASSET='/app/app.js'
code -A "$BOT_UA" "$BASE$ASSET" >/dev/null
ASSET_CTX="$(ctx_key "$ASSET")"
sleep 20
asset_ver="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
  --key "{\"PK\":{\"S\":\"CTX#$ASSET_CTX\"},\"SK\":{\"S\":\"POINTER\"}}" \
  --query 'Item.appliedVersion.S' --output text 2>/dev/null)"
if [ -z "$asset_ver" ] || [ "$asset_ver" = "None" ]; then
  ok "no decoy generated for a non-document asset ($ASSET)"
else
  # Not automatically wrong: if CloudFront labels it text/javascript it is a
  # document by content-type. What must never happen is a JSON decoy for it.
  skp "$ASSET produced version $asset_ver — inspect its archetype/detect evidence"
fi

if [ -n "$QUEUE" ] && [ "$QUEUE" != "None" ]; then
  dlq="$(aws sqs get-queue-attributes --queue-url "${QUEUE%.fifo}-dlq.fifo" \
    --attribute-names ApproximateNumberOfMessages --region "$REGION" \
    --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null)"
  [ -n "$dlq" ] && [ "$dlq" != "None" ] \
    && echo "  DLQ depth: $dlq (non-zero is expected only for unsupported media / rejected ingests)" \
    || true
fi

# ---------------------------------------------------------------------------
head_ "10. The read-back beacons report that content was actually read"
# ---------------------------------------------------------------------------
# Serving a decoy only proves we handed it over. The beacons say it was READ, and
# there are two because they catch different readers:
#   .css  — the decoy's own stylesheet. Any client that RENDERS the page fetches it
#           without choosing to, so this survives a harvester that ignores links.
#   plain — the text-alternative link, fired only if something follows it.
# Both must be keyed by the page's own id (the same 8-hex token), or a hit could
# not be traced back to one decoy.
BEACON_TOKEN="$(node -e "
  const html = require('node:fs').readFileSync('/tmp/lab-bot-body', 'utf8');
  const css = (html.match(/<link rel=\"stylesheet\" href=\"[^\"]*\/wm\/([a-f0-9]+)\.css\">/) || [])[1];
  const link = (html.match(/<a href=\"[^\"]*\/wm\/([a-f0-9]+)\" rel=\"alternate\"/) || [])[1];
  process.stdout.write(css && link === css ? css : '');
" 2>/dev/null)"

if [ -z "$BEACON_TOKEN" ]; then
  no "the decoy is missing a beacon carrier, or its two carriers disagree"
else
  ok "both beacons are keyed by the page's own id (/wm/$BEACON_TOKEN[.css])"

  # The carrier that needs no cooperation: served as real CSS, so a renderer fetching
  # it sees a stylesheet, not a tell.
  read -r st ct < <(curl -s -o /tmp/lab-beacon-css -A "$BOT_UA" -m 30 \
    -H "Referer: $BASE$PROBE_PATH" -w '%{http_code} %{content_type}' "$BASE/wm/$BEACON_TOKEN.css")
  case "$st$ct" in
    200*text/css*) ok "the stylesheet beacon serves real text/css (a renderer fetches it silently)" ;;
    *) no "the stylesheet beacon -> status=$st type=$ct (expected 200 text/css)" ;;
  esac

  read -r st ct < <(curl -s -o /tmp/lab-beacon -A "$BOT_UA" -m 30 \
    -H "Referer: https://e2e-suite.invalid/" -w '%{http_code} %{content_type}' "$BASE/wm/$BEACON_TOKEN")
  case "$st$ct" in
    200*text/plain*) ok "following the beacon -> 200 text/plain, answered at the edge" ;;
    *) no "following the beacon -> status=$st type=$ct (expected 200 text/plain)" ;;
  esac
  # The beacon is a tripwire, not a way in: it must not hand out more decoy prose.
  is_decoy /tmp/lab-beacon \
    && no "the beacon response is itself decoy content" \
    || ok "the beacon response leaks no decoy content"

  if [ -z "$ACCESS_LOG_GROUP" ] || [ "$ACCESS_LOG_GROUP" = "None" ]; then
    skp "no CffLogGroupName output — cannot confirm the hit was recorded"
  else
    # The hits have to reach a log, because nothing about a beacon is stored in the
    # artifact. That log is now the ACCESS log: the edge writes its state onto the
    # request's own record with cf.logCustomData instead of a second CloudWatch line.
    # The value is URL-encoded there, hence %22 rather than a quote.
    #
    # Poll until BOTH carriers show up — an earlier run's hit can satisfy a "did anything
    # arrive?" check while this run's second carrier is still propagating, which is how
    # this assertion first passed for the wrong reason. Access-log delivery is minutes.
    kinds=""
    for _ in $(seq 1 20); do
      kinds="$(aws logs filter-log-events --log-group-name "$ACCESS_LOG_GROUP" --region "$REGION" \
        --start-time $(( ($(date +%s) - 1800) * 1000 )) \
        --filter-pattern "\"$BEACON_TOKEN\"" --query 'events[].message' --output text 2>/dev/null \
        | grep -o '%22kind%22:%22[a-z]*%22' | sort -u | tr '\n' ' ')"
      case "$kinds" in *css*link*|*link*css*) break ;; esac
      sleep 20
    done
    case "$kinds" in
      *css*link*|*link*css*)
        ok "both carriers recorded as canary_hit with wm=$BEACON_TOKEN ($kinds)" ;;
      *css*|*link*)
        skp "only one carrier has been delivered yet ($kinds) — access logs lag by minutes" ;;
      *)
        skp "no beacon hit delivered yet — access-log delivery lags by minutes; re-run" ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------
head_ "11. Every link a decoy emits is attributable to the decoy that emitted it"
# ---------------------------------------------------------------------------
# A decoy's links point at sibling paths that do not exist on the real site, so
# following one creates a NEW context — that is how the maze deepens. Without a token
# on the link that request is anonymous: a crawler asks for /some-slug and nothing
# says which decoy sent it. Referer would answer it, and crawlers routinely omit
# Referer, so the link carries the answer itself as `?s=<emitting page id>`.
LINK_PATH="$(node -e "
  const html = require('node:fs').readFileSync('/tmp/lab-bot-body', 'utf8');
  // The page's own id is its beacon stylesheet token; every emitted link must
  // carry it as ?s=.
  const own = (html.match(/<link rel=\"stylesheet\" href=\"[^\"]*\/wm\/([a-f0-9]+)\.css\">/) || [])[1];
  // Sibling links only: the beacon link carries the token as its PATH, not as ?s=.
  const hrefs = [...html.matchAll(/href=\"([^\"]*\?s=[^\"]+)\"/g)].map((m) => m[1]);
  // Every one of them, not just the first: one untracked link is a hole in the graph.
  const allTracked = hrefs.length > 0 && hrefs.every((h) => h.includes('?s=' + own));
  // Absolute now, so hand back just the path+query to request against \\$BASE.
  const first = allTracked ? hrefs[0] : '';
  process.stdout.write(first ? first.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '') : '');
" 2>/dev/null)"

if [ -z "$LINK_PATH" ]; then
  no "the decoy emits no links, or one of them carries no tracking token"
else
  ok "every link the decoy emits carries its own page id (${LINK_PATH})"
  # Following it must show up as `from` on the ask for the NEW context.
  curl -s -o /dev/null -A "$BOT_UA" -m 30 "$BASE/$LINK_PATH"
  TOKEN="${LINK_PATH##*?s=}"; TOKEN="${TOKEN%%[&?]*}"   # links carry ?s=<token>&c=<ctx>
  if [ -z "$ACCESS_LOG_GROUP" ] || [ "$ACCESS_LOG_GROUP" = "None" ]; then
    skp "no AccessLogGroupName output — cannot confirm the crawl graph was recorded"
  else
    # Filter on the bare token and match the field locally. A CloudWatch pattern with
    # escaped quotes — "\"from\":\"<token>\"" — silently matches NOTHING through the
    # CLI even when the line is right there, which reads as a missing log rather than a
    # quoting problem.
    graph=""
    for _ in $(seq 1 20); do
      graph="$(aws logs filter-log-events --log-group-name "$ACCESS_LOG_GROUP" --region "$REGION" \
        --start-time $(( ($(date +%s) - 1800) * 1000 )) \
        --filter-pattern "\"$TOKEN\"" --query 'events[].message' --output text 2>/dev/null \
        | tr '\t' '\n' | grep -c "%22from%22:%22$TOKEN%22")"
      [ -n "$graph" ] && [ "$graph" != "0" ] && break
      sleep 20
    done
    if [ -n "$graph" ] && [ "$graph" != "0" ]; then
      ok "following it is recorded as from=$TOKEN, so the crawl graph rebuilds without Referer"
    else
      skp "the 'from' record has not been delivered yet — access logs lag by minutes; re-run"
    fi
  fi
fi

# ---------------------------------------------------------------------------
head_ "12. A future visitor arriving on a decoy link is attributable"
# ---------------------------------------------------------------------------
# The payoff of absolute, tokenised links. A decoy is scraped into a corpus, a model
# later hands one of its URLs to a PERSON, the person clicks it — and that request is
# not flagged by WAF, so the viewer-request function returns early and the edge log says
# nothing at all. CloudFront's ACCESS log records it regardless, with the token in the
# query string, plus the referer and agent that say the content reached someone.
#
# Access-log delivery is minutes, not seconds, so this scenario is slow by nature and
# reports SKIP rather than FAIL when the window has not caught up.
ACCESS_LOG="$ACCESS_LOG_GROUP"
if [ -z "$ACCESS_LOG" ] || [ "$ACCESS_LOG" = "None" ]; then
  skp "no AccessLogGroupName output — cannot verify arrivals on decoy links"
elif [ -z "${BEACON_TOKEN:-}" ]; then
  skp "no decoy token from scenario 10 — cannot verify arrivals"
else
  # Links must be ABSOLUTE or this whole flow is impossible: extracted from the page
  # into a corpus, a relative href loses the host and can never be clicked back to us.
  if grep -qE 'href="https?://[^"]+\?s=' /tmp/lab-bot-body; then
    ok "the decoy's links are absolute, so they survive being extracted from the page"
  else
    no "the decoy's links are relative — a scraped copy could never lead anyone back"
  fi

  ARRIVAL_PATH="/products/e2e-$(date +%s)"
  curl -s -o /dev/null -A "$HUMAN_UA" -m 30 -H 'Referer: https://chat.example.invalid/' \
    "$BASE$ARRIVAL_PATH?s=$BEACON_TOKEN"
  found=""
  for _ in $(seq 1 24); do
    found="$(aws logs filter-log-events --log-group-name "$ACCESS_LOG" --region "$REGION" \
      --start-time $(( ($(date +%s) - 1800) * 1000 )) \
      --filter-pattern "\"$ARRIVAL_PATH\"" --query 'events[].message' --output text 2>/dev/null \
      | grep -c "s=$BEACON_TOKEN")"
    [ -n "$found" ] && [ "$found" != "0" ] && break
    sleep 20
  done
  if [ -n "$found" ] && [ "$found" != "0" ]; then
    ok "a browser arriving on a decoy link is recorded with its token (wm=$BEACON_TOKEN)"
  else
    skp "access-log delivery has not caught up (minutes, not seconds) — re-run to confirm"
  fi
fi

# ---------------------------------------------------------------------------
head_ "13. The maze is a graph: following a link serves a SIBLING, not a dead end"
# ---------------------------------------------------------------------------
# The generator writes a graph of interlinked pages, but the edge could only ever serve
# the entry page: a crawler following a decoy's link asked for a path the real site does
# not have, which became a NEW context whose ingest failed forever. The pages existed and
# were unreachable, so the maze was one page deep.
#
# Decoy links now carry `&c=<context>` — `?s=` is a hash prefix and cannot be reversed to
# a context — and the marker lists the version's sibling slugs, so the edge resolves the
# link against the version that emitted it.
LINK_URL="$(node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const html = readFileSync('/tmp/lab-bot-body', 'utf8');
  const m = html.match(/href=\"(https?:[^\"]*\?s=[a-f0-9]+&(?:amp;)?c=[0-9a-f]{20})\"/);
  process.stdout.write(m ? m[1].replace(/&amp;/g, '&') : '');
" 2>/dev/null)"

if [ -z "$LINK_URL" ]; then
  skp "no context-carrying link on this decoy — rotate it (older versions link without &c=)"
else
  ok "decoy links carry their emitting context (&c=), so they can be resolved"

  # Capture the failure count for the sibling's own path BEFORE following the link, so the
  # assertion below measures what THIS run did rather than what history left behind.
  SIB_PATH="${LINK_URL#*://}"      # strip scheme and host
  SIB_PATH="/${SIB_PATH#*/}"       # keep the path, with its leading slash
  SIB_PATH="${SIB_PATH%%\?*}"      # drop the query string
  SIB_CTX="$(node -e "
    const c = require('node:crypto');
    process.stdout.write(c.createHash('sha256').update('v1:$SIB_PATH').digest('hex').slice(0, 20));
  ")"
  fails_before="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"CTX#$SIB_CTX\"},\"SK\":{\"S\":\"POINTER\"}}" \
    --query 'Item.failCount.N' --output text 2>/dev/null)"
  [ -n "$fails_before" ] && [ "$fails_before" != "None" ] || fails_before=0
  read -r st sz < <(curl -s -o /tmp/lab-sibling -A "$BOT_UA" -m 30 -w '%{http_code} %{size_download}' "$LINK_URL")
  if [ "$st" = "200" ]; then
    ok "following a decoy link -> 200 (not the 403 of a path that does not exist)"
  else
    no "following a decoy link -> $st (expected 200 from the sibling page)"
  fi
  # It has to be a DIFFERENT decoy page, or "depth" is just the entry page again.
  # Each page's identity is its beacon token (first 8 hex of its own dpid).
  entry_tok="$(decoy_token /tmp/lab-bot-body)"
  sib_tok="$(decoy_token /tmp/lab-sibling)"
  if [ -n "$entry_tok" ] && [ -n "$sib_tok" ] && [ "$entry_tok" != "$sib_tok" ]; then
    ok "the sibling is a DIFFERENT decoy page (its own beacon token), so the maze has depth"
  else
    no "the link led to the same page, or to something with no beacon token at all"
  fi

  # THE invariant, on this path too: depth must not become a way to serve people decoys.
  curl -s -o /tmp/lab-sibling-human -A "$HUMAN_UA" -m 30 "$LINK_URL"
  if is_decoy /tmp/lab-sibling-human; then
    no "CACHE/ROUTE POISONED: a visitor following a decoy link was served decoy content"
  else
    ok "a visitor following the same link gets no decoy"
  fi

  # And following it must not spend anything generating a page that only exists inside the
  # fiction. Compared BEFORE/AFTER on purpose: an absolute "no failures" assertion is
  # polluted by history, because a context that failed under an older release stays failed.
  sleep 25
  fails_after="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"CTX#$SIB_CTX\"},\"SK\":{\"S\":\"POINTER\"}}" \
    --query 'Item.failCount.N' --output text 2>/dev/null)"
  [ -n "$fails_after" ] && [ "$fails_after" != "None" ] || fails_after=0
  if [ "$fails_after" -le "$fails_before" ]; then
    ok "following the link asked for nothing: $SIB_PATH failures unchanged at $fails_after"
  else
    no "following the link tried to generate $SIB_PATH ($fails_before -> $fails_after failures)"
  fi
fi

# ---------------------------------------------------------------------------
head_ "14. Generation spend has a ceiling: a new context is admitted against a budget"
# ---------------------------------------------------------------------------
# The accounting path (edge -> subscription -> parser -> DynamoDB), provable at
# ANY cap. The ceiling itself — asks dropped once the window is spent, and the
# next window admitting them — needs a cap this suite would trip over long
# before this scenario, so it lives in ./scripts/budget-test.sh against a
# test-sized stack.
CAP="$(out GenBudgetPerWindow)"
WIN="$(out GenBudgetWindowSeconds)"
if [ -z "$CAP" ] || [ "$CAP" = "None" ]; then
  skp "stack has no budget outputs — deployed before threat-model M2 was closed?"
else
  PROBE="/budget-probe-$(date +%s)"
  code -A "$BOT_UA" "$BASE$PROBE" >/dev/null
  PROBE_CTX="$(ctx_key "$PROBE")"
  # The mark is written BEFORE the enqueue, so it appears without waiting on
  # generation; only log delivery and the parser are in front of it.
  probe_win=""
  for _ in $(seq 1 12); do
    sleep 10
    probe_win="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
      --key "{\"PK\":{\"S\":\"ADMIT#$PROBE_CTX\"},\"SK\":{\"S\":\"ADMIT\"}}" \
      --query 'Item.window.N' --output text 2>/dev/null)"
    [ -n "$probe_win" ] && [ "$probe_win" != "None" ] && break
  done
  if [ -n "$probe_win" ] && [ "$probe_win" != "None" ]; then
    ok "a fresh context spent one admission (ADMIT mark in window $probe_win)"
    count="$(aws dynamodb get-item --table-name "$TABLE" --region "$REGION" \
      --key "{\"PK\":{\"S\":\"BUDGET#$probe_win\"},\"SK\":{\"S\":\"WINDOW\"}}" \
      --query 'Item.admitted.N' --output text 2>/dev/null)"
    if [ -n "$count" ] && [ "$count" != "None" ] && [ "$count" -ge 1 ] && [ "$count" -le "$CAP" ]; then
      ok "the window counter is counting and within the cap ($count/$CAP per ${WIN}s)"
    else
      no "window counter missing or out of range (admitted=$count cap=$CAP)"
    fi
  else
    no "no ADMIT mark for $PROBE — the budget is not metering, so spend is unbounded (M2)"
  fi
fi

# ---------------------------------------------------------------------------
head_ "Summary"
# ---------------------------------------------------------------------------
printf '  %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || exit 1
