#!/usr/bin/env bash
# AI Maze — run every DEPLOYED saved Logs Insights query against the real log
# group and report which ones actually execute.
#
#   ./scripts/verify-queries.sh [stack-name]     # default: AiMazePoc
#
# Saved queries are code that nothing else exercises: `cdk deploy` will happily ship a
# query CloudWatch refuses to run, and the only symptom is an empty console panel days
# later. One of these shipped broken for exactly that reason — an aggregate aliased to
# a name that already existed as a field ("Ephemeral field is already defined").
#
# It checks BOTH surfaces: the saved query definitions and every log widget on the
# dashboard. The widgets are built from the same constants as the saved queries, but
# "the same constant" is an assumption about the code rather than a fact about what is
# deployed, so both are executed verbatim.
#
# Read-only. Exits non-zero if any query is malformed or fails.
#
# NOTE: query strings contain backticks. They MUST be passed via file:// — inside a
# double-quoted shell variable bash would run them as command substitution, which is
# its own way of reporting every query as broken.

set -uo pipefail

STACK="${1:-AiMazePoc}"
REGION="${AWS_REGION:-us-east-1}"
HOURS="${HOURS:-24}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 2; }; }
need aws; need python3

# Queries span two log groups now: the edge function's and CloudFront's access log.
# Each query definition names its own, so use that rather than assuming one.
LOG_GROUP="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CffLogGroupName'].OutputValue" --output text 2>/dev/null)"
if [ -z "$LOG_GROUP" ] || [ "$LOG_GROUP" = "None" ]; then
  echo "could not resolve the edge log group for $STACK" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

aws logs describe-query-definitions --region "$REGION" \
  --query-definition-name-prefix "AI Maze/$STACK" \
  --query 'queryDefinitions[].[name,queryString,logGroupNames]' --output json > "$WORK/defs.json"

# Dashboard widgets carry their own copy of the query text, so pull them too.
aws cloudwatch get-dashboard --region "$REGION" --dashboard-name "$STACK-maze" \
  --query DashboardBody --output text > "$WORK/dash.json" 2>/dev/null || echo '{}' > "$WORK/dash.json"

python3 - "$WORK" <<'PY'
import json, re, sys, os
work = sys.argv[1]
n = 0
defs = json.load(open(os.path.join(work, 'defs.json')))
for row in sorted(defs):
    name, q = row[0], row[1]
    groups = row[2] if len(row) > 2 and row[2] else []
    open(os.path.join(work, f'{n:02d}.q'), 'w').write(q)
    open(os.path.join(work, f'{n:02d}.n'), 'w').write('saved:     ' + name.split('/')[-1])
    open(os.path.join(work, f'{n:02d}.g'), 'w').write(groups[0] if groups else '')
    n += 1
saved = n
try:
    dash = json.loads(open(os.path.join(work, 'dash.json')).read())
except ValueError:
    dash = {}
for w in dash.get('widgets', []):
    q = (w.get('properties') or {}).get('query')
    if not q:
        continue
    # A widget stores its query with a leading `SOURCE '<log group>' |`. The console
    # understands that; StartQuery with --log-group-name does not, and rejects it as
    # "unexpected symbol found |". Strip exactly that prefix and nothing else, so what
    # gets executed is still the widget's own query text.
    if q.lstrip().startswith('SOURCE '):
        bar = q.index('|')
        q = q[bar + 1:].lstrip()
    # A widget's SOURCE prefix names its log group; keep it so the right one is used.
    group = ''
    src = re.match(r"\s*SOURCE\s+'([^']+)'", (w.get('properties') or {}).get('query') or '')
    if src:
        group = src.group(1)
    open(os.path.join(work, f'{n:02d}.q'), 'w').write(q)
    open(os.path.join(work, f'{n:02d}.n'), 'w').write('dashboard: ' + (w['properties'].get('title') or '(untitled)'))
    open(os.path.join(work, f'{n:02d}.g'), 'w').write(group)
    n += 1
if not n:
    print('no saved queries or dashboard widgets found for this stack', file=sys.stderr)
    sys.exit(2)
print(f'{saved} saved queries, {n - saved} dashboard log widgets')
PY

START=$(( $(date +%s) - HOURS * 3600 ))
END=$(date +%s)
fail=0

echo "log group: $LOG_GROUP"
for q in "$WORK"/*.q; do
  name="$(cat "${q%.q}.n")"
  group="$(cat "${q%.q}.g" 2>/dev/null)"
  [ -n "$group" ] || group="$LOG_GROUP"
  qid="$(aws logs start-query --log-group-name "$group" --region "$REGION" \
    --start-time "$START" --end-time "$END" --query-string "file://$q" \
    --query queryId --output text 2>&1)"
  case "$qid" in
    *Exception*|*ERROR*)
      printf '  \033[31mMALFORMED\033[0m %s\n' "$name"
      printf '    %s\n' "$(printf '%s' "$qid" | tr '\n' ' ' | cut -c1-200)"
      fail=$((fail+1)); continue ;;
  esac
  status=""
  for _ in $(seq 1 20); do
    status="$(aws logs get-query-results --query-id "$qid" --region "$REGION" \
      --query status --output text 2>/dev/null)"
    [ "$status" = "Complete" ] && break
    case "$status" in Failed|Cancelled) break ;; esac
    sleep 3
  done
  if [ "$status" = "Complete" ]; then
    rows="$(aws logs get-query-results --query-id "$qid" --region "$REGION" \
      --query 'length(results)' --output text 2>/dev/null)"
    # 0 rows is fine (a quiet window); refusing to run is not.
    printf '  \033[32mRUNS\033[0m  %-78s %s rows\n' "$name" "$rows"
  else
    printf '  \033[31m%s\033[0m %s\n' "${status:-TIMEOUT}" "$name"
    fail=$((fail+1))
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "every deployed query executes (saved definitions and dashboard widgets)"
else
  echo "$fail query/queries broken"
fi
[ "$fail" -eq 0 ] || exit 1
