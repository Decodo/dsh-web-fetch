#!/usr/bin/env bash
set -euo pipefail
DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME="$DEV/home"
DSH="$DEV/node_modules/.bin/dsh"
[ -x "$DSH" ] || { echo "run ./dev/setup.sh first" >&2; exit 1; }
(cd "$(dirname "$DEV")" && pnpm --silent build)

if [ -z "${SCRAPER_API_TOKEN:-}" ] && [ -f "$HOME/.config/decodo/config.json" ]; then
  SCRAPER_API_TOKEN="$(node -p "require('$HOME/.config/decodo/config.json').authToken || ''")"
  export SCRAPER_API_TOKEN
fi
[ -n "${SCRAPER_API_TOKEN:-}" ] || echo "warning: SCRAPER_API_TOKEN is unset; web_fetch will report the decodo provider unavailable" >&2
[ -n "${NEXOS_API_KEY:-}" ] || echo "warning: NEXOS_API_KEY is unset; the model route in model.patch.yml will fail" >&2

case "${1:-}" in
  web)  shift; exec "$DSH" web --patch "$DEV/model.patch.yml" "$@" ;;
  *)    exec "$DSH" --profile headless --patch "$DEV/model.patch.yml" "$@" ;;
esac
