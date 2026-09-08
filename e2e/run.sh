#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/dsh-web-fetch-e2e}"
export DSH_HOME="$WORK/home"
mkdir -p "$WORK" "$DSH_HOME" "$ROOT/e2e/results"
cd "$WORK"

[ -f package.json ] || pnpm init >/dev/null
pnpm add "@deepseek-ai/dsh@${DSH_VERSION:-latest}" >/dev/null
DSH="$WORK/node_modules/.bin/dsh"
export E2E_DSH_PKG="$WORK/node_modules/@deepseek-ai/dsh/package.json"
echo "dsh $("$DSH" --version)"

"$DSH" plugin --profile headless add "$ROOT" >/dev/null
"$DSH" plugin --profile headless add "$ROOT/e2e/bench" 2>/dev/null >/dev/null || true

echo "== gate 1: composed config after dsh plugin add (no manual yml edit)"
"$DSH" --profile headless --dump-config > "$ROOT/e2e/results/dump-config.yml"
grep -nE -A5 '^- id: (web|tool-web|web-fetch-decodo)$' "$ROOT/e2e/results/dump-config.yml"

echo "== gates 2+3: bench"
: "${SCRAPER_API_TOKEN:?set SCRAPER_API_TOKEN}"
E2E_MODE=bench E2E_URLS="$ROOT/e2e/urls.json" E2E_OUT="$ROOT/e2e/results/bench.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop"

echo "== gate 4: token unset"
env -u SCRAPER_API_TOKEN E2E_MODE=gate4 E2E_OUT="$ROOT/e2e/results/gate4-unset.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop"
echo "== gate 4: wrong token"
SCRAPER_API_TOKEN=bm90YXRva2Vu E2E_MODE=gate4 E2E_OUT="$ROOT/e2e/results/gate4-wrong.json" \
  "$DSH" --profile headless --patch "$ROOT/e2e/bench.patch.yml" "noop"
