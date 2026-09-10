#!/usr/bin/env bash
set -euo pipefail
DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME="$DEV/home"
DSH="$DEV/node_modules/.bin/dsh"
[ -x "$DSH" ] || { echo "run ./dev/setup.sh first" >&2; exit 1; }
(cd "$(dirname "$DEV")" && pnpm --silent build)

if [ -z "${DECODO_API_KEY:-}" ] && [ -z "${SCRAPER_API_TOKEN:-}" ] && [ -f "$HOME/.config/decodo/config.json" ]; then
  SCRAPER_API_TOKEN="$(node -p "require('$HOME/.config/decodo/config.json').authToken || ''")"
  export SCRAPER_API_TOKEN
  echo "using the Decodo CLI token from ~/.config/decodo/config.json; fetches bill that account" >&2
fi
[ -n "${DECODO_API_KEY:-}${SCRAPER_API_TOKEN:-}" ] || echo "warning: neither DECODO_API_KEY nor SCRAPER_API_TOKEN is set; web_fetch will report the decodo provider unavailable" >&2
for v in TEST_GATEWAY_URL TEST_API_KEY TEST_MODEL; do
  [ -n "${!v:-}" ] || echo "warning: $v is unset; the model route in model.patch.yml will fail" >&2
done

case "${1:-}" in
  web)  shift; exec "$DSH" web --patch "$DEV/model.patch.yml" "$@" ;;
  *)    exec "$DSH" --profile headless --patch "$DEV/model.patch.yml" "$@" ;;
esac
