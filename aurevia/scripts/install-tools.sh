#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

node scripts/check-node-version.mjs
npm ci --include=dev

if [[ "${1:-}" == "--with-deps" ]]; then
  npm run browsers:install -- --with-deps
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--with-deps]\n' "$0" >&2
  exit 2
else
  npm run browsers:install
fi

npm run tools:verify
