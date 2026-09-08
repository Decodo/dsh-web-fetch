#!/usr/bin/env bash
set -euo pipefail
DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DEV")"
export DSH_HOME="$DEV/home"
mkdir -p "$DSH_HOME"
cd "$DEV"

(cd "$ROOT" && pnpm install --silent && pnpm --silent build)
pnpm install
DSH="$DEV/node_modules/.bin/dsh"
echo "dsh $("$DSH" --version)"

for profile in headless web; do
  "$DSH" plugin --profile "$profile" add "$ROOT"
done

echo
echo "== composed web rows (headless profile)"
"$DSH" --profile headless --dump-config | grep -A4 -E '^- id: (web|tool-web|web-fetch-decodo)$'
echo
echo "Done. Next: ./dev/dsh.sh \"say hi and list your tools\"   or   ./dev/dsh.sh web"
