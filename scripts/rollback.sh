#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <git-ref>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"

ROLLBACK_REF="$1"
DEPLOY_DIR="${NAV_DEPLOY_DIR:-/home/web/html/nav}"
REMOTE_NAME="${NAV_REMOTE_NAME:-origin}"

echo "[rollback] repo: $REPO_ROOT"
echo "[rollback] ref: $ROLLBACK_REF"
echo "[rollback] target: $DEPLOY_DIR"

cd "$REPO_ROOT"
git fetch "$REMOTE_NAME"
git checkout "$ROLLBACK_REF"

cd "$APP_DIR"
npm install
npm run build

mkdir -p "$DEPLOY_DIR"
find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -r dist/. "$DEPLOY_DIR/"

echo "[rollback] published commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
echo "[rollback] done"
