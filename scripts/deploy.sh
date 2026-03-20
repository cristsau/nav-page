#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$REPO_ROOT/app"

DEPLOY_REF="${1:-master}"
DEPLOY_DIR="${NAV_DEPLOY_DIR:-/home/web/html/nav}"
REMOTE_NAME="${NAV_REMOTE_NAME:-origin}"
VITE_AUTH_MODE_VALUE="${NAV_VITE_AUTH_MODE:-backend}"
VITE_API_BASE_URL_VALUE="${NAV_VITE_API_BASE_URL:-/api}"

echo "[deploy] repo: $REPO_ROOT"
echo "[deploy] app: $APP_DIR"
echo "[deploy] ref: $DEPLOY_REF"
echo "[deploy] target: $DEPLOY_DIR"
echo "[deploy] vite auth mode: $VITE_AUTH_MODE_VALUE"
echo "[deploy] vite api base url: $VITE_API_BASE_URL_VALUE"

cd "$REPO_ROOT"

git fetch "$REMOTE_NAME"

if git show-ref --verify --quiet "refs/heads/$DEPLOY_REF"; then
  git checkout "$DEPLOY_REF"
  git pull --ff-only "$REMOTE_NAME" "$DEPLOY_REF"
else
  git checkout "$DEPLOY_REF"
fi

cd "$APP_DIR"

npm install
VITE_AUTH_MODE="$VITE_AUTH_MODE_VALUE" VITE_API_BASE_URL="$VITE_API_BASE_URL_VALUE" npm run build

mkdir -p "$DEPLOY_DIR"
find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -r dist/. "$DEPLOY_DIR/"

echo "[deploy] published commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
echo "[deploy] done"
