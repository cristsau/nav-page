#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/api"

cd "$REPO_ROOT"

if [[ ! -f "$API_DIR/.env" ]]; then
  cp "$API_DIR/.env.example" "$API_DIR/.env"
  echo "[backend] created $API_DIR/.env from example"
fi

docker compose -f "$REPO_ROOT/docker-compose.backend.yml" up -d --build
docker compose -f "$REPO_ROOT/docker-compose.backend.yml" ps

echo "[backend] done"
