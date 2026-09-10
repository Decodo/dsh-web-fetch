#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/dsh-web-fetch-e2e}"
RESULTS="$ROOT/e2e/results"
export DSH_HOME="$WORK/home"
mkdir -p "$WORK" "$DSH_HOME" "$RESULTS"
cd "$WORK"

[ -f package.json ] || cat > package.json <<'JSON'
{
  "name": "dsh-web-fetch-e2e",
  "private": true,
  "pnpm": {
    "onlyBuiltDependencies": ["@deepseek-ai/dsh-subprocess-local", "@google/genai", "koffi", "node-pty", "protobufjs"]
  }
}
JSON
pnpm add "@deepseek-ai/dsh@${DSH_VERSION:-latest}" >/dev/null
DSH="$WORK/node_modules/.bin/dsh"
export E2E_DSH_PKG="$WORK/node_modules/@deepseek-ai/dsh/package.json"
echo "dsh $("$DSH" --version)"

"$DSH" plugin --profile headless add "$ROOT" >/dev/null
"$DSH" plugin --profile headless add "$ROOT/e2e/bench" >/dev/null 2>&1

failed=0
gate() {
  if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1"; failed=1; fi
}

"$DSH" --profile headless --dump-config > "$RESULTS/dump-config.yml"
grep -q 'fetchProvider: decodo' "$RESULTS/dump-config.yml" && grep -q "name: '@decodo/dsh-web-fetch'" "$RESULTS/dump-config.yml" \
  && grep -q 'fetchTimeoutMs: 60000' "$RESULTS/dump-config.yml"
gate "plugin add activates fetch and pins the provider" $?

: "${SCRAPER_API_TOKEN:?set SCRAPER_API_TOKEN}"
E2E_MODE=bench E2E_URLS="$ROOT/e2e/urls.json" E2E_OUT="$RESULTS/bench.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop" >/dev/null
node -e '
const g = require(process.argv[1]).summary.gates
let bad = 0
for (const [k, v] of Object.entries(g)) { console.log(`${v.pass ? "PASS" : "FAIL"} ${k} = ${v.value}`); if (!v.pass) bad = 1 }
process.exit(bad)' "$RESULTS/bench.json" || failed=1

expect_code() {
  node -e 'process.exit(require(process.argv[1]).dsh.code === process.argv[2] ? 0 : 1)' "$1" "$2"
}
env -u SCRAPER_API_TOKEN -u DECODO_API_KEY E2E_MODE=missing-token E2E_OUT="$RESULTS/missing-token.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop" >/dev/null
expect_code "$RESULTS/missing-token.json" WEB_PROVIDER_CONFIGURED_UNAVAILABLE
gate "missing token fails clearly with no fallback" $?

SCRAPER_API_TOKEN=bm90YXRva2Vu E2E_MODE=missing-token E2E_OUT="$RESULTS/wrong-token.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop" >/dev/null
expect_code "$RESULTS/wrong-token.json" DECODO_AUTH_FAILED
gate "wrong token surfaces the API auth error" $?

env -u SCRAPER_API_TOKEN DECODO_API_KEY=notakey E2E_MODE=missing-token E2E_OUT="$RESULTS/wrong-api-key.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop" >/dev/null
expect_code "$RESULTS/wrong-api-key.json" DECODO_AUTH_FAILED
gate "wrong API key surfaces the API auth error" $?

exit $failed
