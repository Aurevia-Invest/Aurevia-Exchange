#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
browser_path="$project_root/tools/playwright/browsers"
install_os_deps=false

if [[ "${1:-}" == "--with-deps" ]]; then
  install_os_deps=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--with-deps]\n' "$0" >&2
  exit 2
fi

cd "$project_root"
export PLAYWRIGHT_BROWSERS_PATH="$browser_path"
mkdir -p "$browser_path"

if [[ "$install_os_deps" == true ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    npm exec -- playwright install-deps chromium
  elif command -v sudo >/dev/null 2>&1; then
    sudo env "PATH=$PATH" npm exec -- playwright install-deps chromium
  else
    printf 'Installing Linux browser libraries requires root or sudo. Run this script with --with-deps from an authorized account.\n' >&2
    exit 1
  fi
fi

npm exec -- playwright install chromium
printf 'Chromium browser cache: %s\n' "$browser_path"
