#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/api"
POSTGRES_CONTAINER="${NAV_POSTGRES_CONTAINER:-nav-postgres}"
POSTGRES_DATA_DIR="${NAV_POSTGRES_DATA_DIR:-/var/lib/domo-nav/postgres}"

fail() {
  printf '[backend] ERROR: %s\n' "$*" >&2
  exit 78
}

[[ "$POSTGRES_DATA_DIR" == /* && "$POSTGRES_DATA_DIR" != / ]] \
  || fail 'NAV_POSTGRES_DATA_DIR must be a bounded absolute path'
[[ ! -L "$POSTGRES_DATA_DIR" ]] \
  || fail 'NAV_POSTGRES_DATA_DIR must not be a symbolic link'

repo_root_real="$(realpath -e -- "$REPO_ROOT")"
postgres_data_real="$(realpath -m -- "$POSTGRES_DATA_DIR")"
case "$postgres_data_real" in
  "$repo_root_real"|"$repo_root_real"/*|/opt/nav-stack/current|/opt/nav-stack/current/*|/opt/nav-stack/releases|/opt/nav-stack/releases/*)
    fail 'NAV_POSTGRES_DATA_DIR must remain outside the source and release trees'
    ;;
esac

if docker inspect "$POSTGRES_CONTAINER" >/dev/null 2>&1; then
  current_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$POSTGRES_CONTAINER")"
  [[ -n "$current_source" ]] \
    || fail "existing $POSTGRES_CONTAINER has no PostgreSQL data mount"
  current_source_real="$(realpath -m -- "$current_source")"
  [[ "$current_source_real" == "$postgres_data_real" ]] \
    || fail "existing $POSTGRES_CONTAINER uses $current_source_real; migrate or restore it to $postgres_data_real before deployment"
fi
install -d -m 0700 -- "$postgres_data_real"
postgres_data_real="$(realpath -e -- "$postgres_data_real")"
export NAV_POSTGRES_DATA_DIR="$postgres_data_real"

cd "$REPO_ROOT"

if [[ ! -f "$API_DIR/.env" ]]; then
  cp "$API_DIR/.env.example" "$API_DIR/.env"
  echo "[backend] created $API_DIR/.env from example"
fi

docker compose -f "$REPO_ROOT/docker-compose.backend.yml" config --quiet
docker compose -f "$REPO_ROOT/docker-compose.backend.yml" up -d --build
docker compose -f "$REPO_ROOT/docker-compose.backend.yml" ps

echo "[backend] done"
