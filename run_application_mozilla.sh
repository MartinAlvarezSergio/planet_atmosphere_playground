#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="http://127.0.0.1:5173"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but was not found in PATH."
  exit 1
fi

cd "$ROOT_DIR"
npm install

npm run dev -- --host 127.0.0.1 --port 5173 &
DEV_PID=$!

sleep 2
if command -v open >/dev/null 2>&1; then
  open -a "Firefox" "$APP_URL" || open "$APP_URL"
fi

wait "$DEV_PID"
