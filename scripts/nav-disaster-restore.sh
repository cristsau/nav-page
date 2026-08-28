#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_CANTCREAT=73
readonly EX_TEMPFAIL=75
readonly EX_CONFIG=78
readonly EX_VERIFY=80
readonly CANONICAL_BACKUP_LOCK_FILE='/run/lock/nav-backup.lock'

PROGRAM_NAME="$(basename "$0")"
CONFIG_FILE="${NAV_BACKUP_CONFIG:-/etc/nav/nav-backup.env}"
BACKUP_DIR=""
REQUEST_APPLY=false
REQUEST_REPLACE=false
REQUEST_IMAGE_SYNC=false
CURRENT_STAGE="initialization"
ROLLBACK_DIR=""
ROLLBACK_ARMED=false
DATABASE_CHANGED=false
IMAGE_CHANGED=false
IMAGE_ROLLBACK_READY=false
FILESYSTEM_ROLLBACK_FILE=""
BACKUP_LOCK_FD=8
RESTORE_LOCK_FD=9

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  nav-disaster-restore.sh --backup DIR [--config FILE] [--apply]
                          [--replace-existing] [--sync-images]

Without --apply the script verifies the complete backup and prints the plan.
--apply additionally requires NAV_ENABLE_DISASTER_RESTORE=true.
--replace-existing additionally requires NAV_ENABLE_DESTRUCTIVE_DR_RESTORE=true.
--sync-images additionally requires NAV_ENABLE_IMAGE_OBJECT_SYNC=true and may
delete remote image objects that are not present in the selected backup.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

fatal() {
  local code="$1"
  shift
  trap - ERR
  log "ERROR [$CURRENT_STAGE]: $*"
  if "$ROLLBACK_ARMED"; then
    rollback_changes || log "automatic rollback was incomplete; use $ROLLBACK_DIR"
  fi
  exit "$code"
}

handle_error() {
  local code="$1"
  local line="$2"
  ((code >= 64 && code <= 125)) || code="$EX_SOFTWARE"
  fatal "$code" "unexpected command failure at line $line"
}

trap 'handle_error "$?" "$LINENO"' ERR
trap 'fatal 130 "interrupted by signal"' INT TERM

assert_safe_file() {
  local path="$1"
  local description="$2"
  local mode owner
  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "$description path must be absolute"
  [[ -f "$path" && ! -L "$path" ]] || fatal "$EX_CONFIG" "$description must be a regular non-symlink file"
  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  [[ "$owner" == "$EUID" ]] || fatal "$EX_CONFIG" "$description must be owned by uid $EUID"
  (( (8#$mode & 022) == 0 )) || fatal "$EX_CONFIG" "$description must not be group/world writable"
}

split_list() {
  local value="$1"
  local -n output_ref="$2"
  # shellcheck disable=SC2034
  IFS=';' read -r -a output_ref <<< "$value"
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" == "true" ]]
}

wait_for_postgres() {
  local ready=false
  local attempt
  for ((attempt=1; attempt<=NAV_DR_READY_ATTEMPTS; attempt++)); do
    if docker exec "$NAV_DB_CONTAINER" \
      pg_isready -U "$NAV_DB_USER" -d "$NAV_DB_NAME" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep "$NAV_DR_READY_INTERVAL_SECONDS"
  done
  "$ready" || fatal "$EX_TEMPFAIL" "PostgreSQL did not become ready"
}

compose_up() {
  local project_dir="$1"
  local compose_file="$2"
  local services_value="$3"
  local services=()
  [[ -f "$compose_file" && ! -L "$compose_file" ]] \
    || fatal "$EX_CONFIG" "Compose file is unavailable: $compose_file"
  split_list "$services_value" services
  ((${#services[@]} > 0)) || fatal "$EX_CONFIG" "Compose service list is empty"
  NAV_POSTGRES_DATA_DIR="$NAV_POSTGRES_DATA_DIR" \
    docker compose --project-directory "$project_dir" -f "$compose_file" \
      up -d --build "${services[@]}"
}

stop_container_list() {
  local value="$1"
  local containers=()
  local container
  split_list "$value" containers
  for container in "${containers[@]}"; do
    [[ -n "$container" ]] || continue
    [[ "$container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
      || fatal "$EX_CONFIG" "invalid container name: $container"
    if container_running "$container"; then
      printf '%s\n' "$container" >> "$ROLLBACK_DIR/running-containers.txt"
      docker stop --time 30 "$container" >/dev/null
    fi
  done
}

restore_previously_running_containers() {
  local container
  [[ -f "$ROLLBACK_DIR/running-containers.txt" ]] || return 0
  while IFS= read -r container || [[ -n "$container" ]]; do
    [[ -n "$container" ]] || continue
    container_exists "$container" && docker start "$container" >/dev/null 2>&1 || true
  done < "$ROLLBACK_DIR/running-containers.txt"
}

safe_target() {
  local target="$1"
  [[ "$target" == /* && "$target" != "/" && "$target" != *$'\t'* && "$target" != *$'\r'* && "$target" != *$'\n'* ]] \
    || fatal "$EX_CONFIG" "unsafe restore target: $target"
  [[ "$target" != "$backup_root_real" && "$target" != "$backup_root_real"/* ]] \
    || fatal "$EX_CONFIG" "restore target must not be inside the backup root"
}

record_rollback_path() {
  local target="$1"
  local saved="$2"
  local kind="$3"
  [[ -n "$saved" ]] || saved='-'
  printf '%s\t%s\t%s\n' "$target" "$saved" "$kind" >> "$FILESYSTEM_ROLLBACK_FILE"
}

restore_path_atomically() {
  local source="$1"
  local target="$2"
  local label="$3"
  local parent base staging saved digest
  safe_target "$target"
  [[ -e "$source" && ! -L "$source" ]] || fatal "$EX_VERIFY" "backup source is missing: $source"
  parent="$(dirname "$target")"
  base="$(basename "$target")"
  install -d -m 0700 -- "$parent"
  digest="$(printf '%s' "$target" | sha256sum | awk '{print substr($1,1,16)}')"
  staging="$(mktemp -d "$parent/.nav-dr-${base}.XXXXXXXX")"
  saved="$ROLLBACK_DIR/files/${label}.${digest}"

  if [[ -d "$source" ]]; then
    cp -a -- "$source"/. "$staging"/
    if [[ -e "$target" || -L "$target" ]]; then
      [[ ! -L "$target" ]] || fatal "$EX_CONFIG" "refused to replace symlink target: $target"
      mv -- "$target" "$saved"
      record_rollback_path "$target" "$saved" directory
    else
      record_rollback_path "$target" "" absent
    fi
    mv -- "$staging" "$target"
  elif [[ -f "$source" ]]; then
    rmdir -- "$staging"
    staging="$parent/.nav-dr-${base}.$$"
    [[ ! -e "$staging" && ! -L "$staging" ]] || fatal "$EX_CANTCREAT" "restore staging file already exists"
    cp -a -- "$source" "$staging"
    if [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" && ! -L "$target" ]] || fatal "$EX_CONFIG" "file restore target has the wrong type: $target"
      mv -- "$target" "$saved"
      record_rollback_path "$target" "$saved" file
    else
      record_rollback_path "$target" "" absent
    fi
    mv -- "$staging" "$target"
  else
    fatal "$EX_VERIFY" "unsupported backup source type: $source"
  fi
}

rollback_filesystem() {
  local records=()
  local record target saved kind index
  [[ -s "$FILESYSTEM_ROLLBACK_FILE" ]] || return 0
  mapfile -t records < "$FILESYSTEM_ROLLBACK_FILE"
  for ((index=${#records[@]}-1; index>=0; index--)); do
    record="${records[$index]}"
    IFS=$'\t' read -r target saved kind <<< "$record"
    safe_target "$target"
    if [[ -e "$target" && ! -L "$target" ]]; then
      if [[ -d "$target" ]]; then
        find -P "$target" -mindepth 1 -delete
        rmdir -- "$target"
      else
        rm -f -- "$target"
      fi
    fi
    if [[ "$kind" != "absent" && "$saved" != "-" && -e "$saved" && ! -L "$saved" ]]; then
      mv -- "$saved" "$target"
    fi
  done
}

restore_database_dump() {
  local dump_file="$1"
  docker exec -i "$NAV_DB_CONTAINER" pg_restore \
    -U "$NAV_DB_USER" -d "$NAV_DB_NAME" \
    --clean --if-exists --single-transaction --exit-on-error \
    --no-owner --no-acl < "$dump_file"
}

rollback_changes() {
  trap - ERR
  CURRENT_STAGE="automatic rollback"
  log "rolling back failed disaster restore"
  if container_exists "$NAV_DB_CONTAINER"; then
    wait_for_postgres || true
    if "$DATABASE_CHANGED" && [[ -s "$ROLLBACK_DIR/database-before.dump" ]]; then
      restore_database_dump "$ROLLBACK_DIR/database-before.dump" \
        || log "database rollback failed"
    fi
  fi
  if "$IMAGE_CHANGED" && "$IMAGE_ROLLBACK_READY"; then
    rclone --config "$NAV_IMAGE_RCLONE_CONFIG" sync \
      "$ROLLBACK_DIR/image-objects-before" "$NAV_IMAGE_RCLONE_REMOTE" --metadata \
      || log "image-object rollback failed"
  fi
  rollback_filesystem || log "filesystem rollback failed"
  restore_previously_running_containers
  ROLLBACK_ARMED=false
}

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --backup)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      BACKUP_DIR="$2"
      shift 2
      ;;
    --apply)
      REQUEST_APPLY=true
      shift
      ;;
    --replace-existing)
      REQUEST_REPLACE=true
      shift
      ;;
    --sync-images)
      REQUEST_IMAGE_SYNC=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit "$EX_USAGE"
      ;;
  esac
done

[[ -n "$BACKUP_DIR" ]] || { usage >&2; exit "$EX_USAGE"; }
assert_safe_file "$CONFIG_FILE" "backup configuration"
# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${NAV_BACKUP_ROOT:=/var/backups/nav}"
: "${NAV_BACKUP_LOCK_FILE:=$CANONICAL_BACKUP_LOCK_FILE}"
: "${NAV_RESTORE_SCRIPT:=/usr/local/sbin/nav-restore-rehearsal}"
: "${NAV_ENABLE_DISASTER_RESTORE:=false}"
: "${NAV_ENABLE_DESTRUCTIVE_DR_RESTORE:=false}"
: "${NAV_ENABLE_IMAGE_OBJECT_SYNC:=false}"
: "${NAV_DR_RESTORE_LOCK_FILE:=/run/lock/nav-disaster-restore.lock}"
: "${NAV_DR_ROLLBACK_ROOT:=/var/backups/nav-disaster-rollback}"
: "${NAV_DB_CONTAINER:=nav-postgres}"
: "${NAV_DB_NAME:=nav}"
: "${NAV_DB_USER:=nav}"
: "${NAV_POSTGRES_DATA_DIR:=}"
: "${NAV_PROJECT_DIR:=/opt/nav}"
: "${NAV_FRONTEND_DIR:=/home/web/html/nav}"
: "${NAV_COMPOSE_PATHS:=}"
: "${NAV_NGINX_PATHS:=}"
: "${NAV_ENV_PATHS:=}"
: "${NAV_EXTRA_CONFIG_PATHS:=}"
: "${NAV_OUTER_PROXY_PATHS:=}"
: "${NAV_NPM_SQLITE_PATH:=}"
: "${NAV_IMAGE_RCLONE_CONFIG:=/etc/nav/imgbed-rclone.conf}"
: "${NAV_IMAGE_RCLONE_REMOTE:=}"
: "${NAV_DR_APP_CONTAINERS:=nav-mail-worker;nav-api;nav-web}"
: "${NAV_DR_PROXY_CONTAINERS:=nginx-proxy-manager}"
: "${NAV_DR_COMPOSE_FILE:=}"
: "${NAV_DR_COMPOSE_PROJECT_DIR:=}"
: "${NAV_DR_DATABASE_SERVICE:=nav-postgres}"
: "${NAV_DR_COMPOSE_SERVICES:=nav-postgres;nav-api;nav-mail-worker}"
: "${NAV_DR_PROXY_COMPOSE_FILE:=}"
: "${NAV_DR_PROXY_COMPOSE_PROJECT_DIR:=}"
: "${NAV_DR_PROXY_COMPOSE_SERVICES:=}"
: "${NAV_DR_HEALTH_URLS:=}"
: "${NAV_DR_READY_ATTEMPTS:=60}"
: "${NAV_DR_READY_INTERVAL_SECONDS:=2}"

[[ "$NAV_BACKUP_LOCK_FILE" == "$CANONICAL_BACKUP_LOCK_FILE" ]] \
  || fatal "$EX_CONFIG" "NAV_BACKUP_LOCK_FILE must remain $CANONICAL_BACKUP_LOCK_FILE"
[[ "$NAV_DR_RESTORE_LOCK_FILE" == /* && "$NAV_DR_RESTORE_LOCK_FILE" != "$CANONICAL_BACKUP_LOCK_FILE" ]] \
  || fatal "$EX_CONFIG" "NAV_DR_RESTORE_LOCK_FILE must be a distinct absolute path"
[[ "$NAV_DR_ROLLBACK_ROOT" == /* && "$NAV_DR_ROLLBACK_ROOT" != "/" ]] \
  || fatal "$EX_CONFIG" "NAV_DR_ROLLBACK_ROOT must be a bounded absolute path"
[[ "$NAV_DR_READY_ATTEMPTS" =~ ^[1-9][0-9]{0,3}$ ]] \
  || fatal "$EX_CONFIG" "NAV_DR_READY_ATTEMPTS is invalid"
[[ "$NAV_DR_READY_INTERVAL_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] \
  || fatal "$EX_CONFIG" "NAV_DR_READY_INTERVAL_SECONDS is invalid"
[[ "$NAV_DR_DATABASE_SERVICE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fatal "$EX_CONFIG" "NAV_DR_DATABASE_SERVICE is invalid"
[[ "$NAV_POSTGRES_DATA_DIR" == /* && "$NAV_POSTGRES_DATA_DIR" != / ]] \
  || fatal "$EX_CONFIG" "NAV_POSTGRES_DATA_DIR must be a bounded absolute path"
[[ ! -L "$NAV_POSTGRES_DATA_DIR" ]] \
  || fatal "$EX_CONFIG" "NAV_POSTGRES_DATA_DIR must not be a symbolic link"

if ((EUID != 0)); then
  if [[ "${CI:-}" != "true" || "${NODE_ENV:-}" != "test" || "${NAV_DISASTER_RESTORE_TEST:-}" != "true" ]]; then
    fatal "$EX_CONFIG" "disaster restore must run as root"
  fi
fi

for command_name in stat realpath flock find sort sha256sum cp mv mktemp awk install docker curl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done
postgres_data_real="$(realpath -m -- "$NAV_POSTGRES_DATA_DIR")"
project_dir_real="$(realpath -m -- "${NAV_DR_COMPOSE_PROJECT_DIR:-$NAV_PROJECT_DIR}")"
case "$postgres_data_real" in
  "$project_dir_real"|"$project_dir_real"/*|/opt/nav-stack/current|/opt/nav-stack/current/*|/opt/nav-stack/releases|/opt/nav-stack/releases/*)
    fatal "$EX_CONFIG" "NAV_POSTGRES_DATA_DIR must remain outside the release tree"
    ;;
esac
NAV_POSTGRES_DATA_DIR="$postgres_data_real"
export NAV_POSTGRES_DATA_DIR
assert_safe_file "$NAV_RESTORE_SCRIPT" "restore verification script"

[[ "$NAV_BACKUP_ROOT" == /* && -d "$NAV_BACKUP_ROOT" && ! -L "$NAV_BACKUP_ROOT" ]] \
  || fatal "$EX_CONFIG" "NAV_BACKUP_ROOT must be an existing non-symlink directory"
backup_root_real="$(realpath -e -- "$NAV_BACKUP_ROOT")"
[[ "$BACKUP_DIR" == /* && -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] \
  || fatal "$EX_CONFIG" "--backup must be an absolute non-symlink directory"
backup_real="$(realpath -e -- "$BACKUP_DIR")"
backup_base="$(basename "$backup_real")"
[[ "$backup_real" == "$backup_root_real"/nav-* ]] \
  || fatal "$EX_CONFIG" "backup is outside NAV_BACKUP_ROOT"
[[ "$backup_base" =~ ^nav-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]] \
  || fatal "$EX_CONFIG" "backup directory name is not recognized"

CURRENT_STAGE="complete backup verification"
"$NAV_RESTORE_SCRIPT" --config "$CONFIG_FILE" --backup "$backup_real"
components_file="$backup_real/metadata/disaster-components.tsv"
[[ -f "$components_file" && ! -L "$components_file" ]] \
  || fatal "$EX_VERIFY" "disaster component manifest is missing"
for component in database release image_objects outer_proxy; do
  grep -Eq "^${component}"$'\t''complete'$'\t' "$components_file" \
    || fatal "$EX_VERIFY" "backup component is incomplete: $component"
done
for required in \
  "$backup_real/database/nav.dump" \
  "$backup_real/release" \
  "$backup_real/frontend" \
  "$backup_real/image-objects" \
  "$backup_real/proxy/npm-database.sqlite" \
  "$backup_real/metadata/image-objects-local.tsv" \
  "$backup_real/metadata/inventory.tsv"; do
  [[ -e "$required" && ! -L "$required" ]] || fatal "$EX_VERIFY" "required disaster artifact is missing: $required"
done

if ! "$REQUEST_APPLY"; then
  log "verified complete disaster backup: $backup_real"
  log "plan: restore release, frontend, configuration, NPM SQLite, PostgreSQL and image objects"
  log "plan only; --apply was not supplied and no state was changed"
  exit 0
fi
is_true "$NAV_ENABLE_DISASTER_RESTORE" \
  || fatal "$EX_CONFIG" "--apply requires NAV_ENABLE_DISASTER_RESTORE=true"
if "$REQUEST_REPLACE"; then
  is_true "$NAV_ENABLE_DESTRUCTIVE_DR_RESTORE" \
    || fatal "$EX_CONFIG" "--replace-existing requires NAV_ENABLE_DESTRUCTIVE_DR_RESTORE=true"
fi
if "$REQUEST_IMAGE_SYNC"; then
  is_true "$NAV_ENABLE_IMAGE_OBJECT_SYNC" \
    || fatal "$EX_CONFIG" "--sync-images requires NAV_ENABLE_IMAGE_OBJECT_SYNC=true"
fi
assert_safe_file "$NAV_IMAGE_RCLONE_CONFIG" "image rclone configuration"
[[ -n "$NAV_IMAGE_RCLONE_REMOTE" ]] || fatal "$EX_CONFIG" "NAV_IMAGE_RCLONE_REMOTE is required"
command -v rclone >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "rclone is required"
command -v sqlite3 >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "sqlite3 is required"

install -d -m 0755 -- /run/lock
exec 8>>"$NAV_BACKUP_LOCK_FILE"
chmod 0600 "$NAV_BACKUP_LOCK_FILE"
flock -n "$BACKUP_LOCK_FD" || fatal "$EX_TEMPFAIL" "a NAV backup or rehearsal is running"
exec 9>>"$NAV_DR_RESTORE_LOCK_FILE"
chmod 0600 "$NAV_DR_RESTORE_LOCK_FILE"
flock -n "$RESTORE_LOCK_FD" || fatal "$EX_TEMPFAIL" "another disaster restore is running"

if container_exists "$NAV_DB_CONTAINER"; then
  current_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}' "$NAV_DB_CONTAINER")"
  [[ -n "$current_source" ]] \
    || fatal "$EX_CONFIG" "existing $NAV_DB_CONTAINER has no PostgreSQL data mount"
  current_source_real="$(realpath -m -- "$current_source")"
  [[ "$current_source_real" == "$postgres_data_real" ]] \
    || fatal "$EX_CONFIG" "existing $NAV_DB_CONTAINER uses a different PostgreSQL data directory"
fi
install -d -m 0700 -- "$NAV_POSTGRES_DATA_DIR"
[[ -d "$NAV_POSTGRES_DATA_DIR" && ! -L "$NAV_POSTGRES_DATA_DIR" ]] \
  || fatal "$EX_CONFIG" "NAV_POSTGRES_DATA_DIR must be a non-symlink directory"
postgres_data_real="$(realpath -e -- "$NAV_POSTGRES_DATA_DIR")"
NAV_POSTGRES_DATA_DIR="$postgres_data_real"
export NAV_POSTGRES_DATA_DIR

install -d -m 0700 -- "$NAV_DR_ROLLBACK_ROOT"
rollback_root_real="$(realpath -e -- "$NAV_DR_ROLLBACK_ROOT")"
[[ "$rollback_root_real" != "/" && "$rollback_root_real" != "$backup_root_real" ]] \
  || fatal "$EX_CONFIG" "rollback root is unsafe"
ROLLBACK_DIR="$rollback_root_real/nav-dr-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
install -d -m 0700 -- "$ROLLBACK_DIR/files"
FILESYSTEM_ROLLBACK_FILE="$ROLLBACK_DIR/filesystem.tsv"
install -m 0600 /dev/null "$FILESYSTEM_ROLLBACK_FILE"
install -m 0600 /dev/null "$ROLLBACK_DIR/running-containers.txt"
ROLLBACK_ARMED=true

CURRENT_STAGE="pre-restore rollback capture"
if container_exists "$NAV_DB_CONTAINER"; then
  wait_for_postgres
  docker exec "$NAV_DB_CONTAINER" pg_dump \
    -U "$NAV_DB_USER" -d "$NAV_DB_NAME" -Fc -Z 6 --no-owner --no-acl \
    > "$ROLLBACK_DIR/database-before.dump"
  [[ -s "$ROLLBACK_DIR/database-before.dump" ]] \
    || fatal "$EX_SOFTWARE" "pre-restore PostgreSQL rollback dump is empty"
fi
install -d -m 0700 -- "$ROLLBACK_DIR/image-objects-before"
rclone --config "$NAV_IMAGE_RCLONE_CONFIG" copy \
  "$NAV_IMAGE_RCLONE_REMOTE" "$ROLLBACK_DIR/image-objects-before" --metadata \
  || fatal "$EX_SOFTWARE" "pre-restore image-object rollback copy failed"
rclone --config "$NAV_IMAGE_RCLONE_CONFIG" check \
  "$NAV_IMAGE_RCLONE_REMOTE" "$ROLLBACK_DIR/image-objects-before" --one-way --size-only \
  || fatal "$EX_SOFTWARE" "pre-restore image-object rollback verification failed"
IMAGE_ROLLBACK_READY=true

CURRENT_STAGE="application and proxy stop"
stop_container_list "$NAV_DR_APP_CONTAINERS"
stop_container_list "$NAV_DR_PROXY_CONTAINERS"

CURRENT_STAGE="release and frontend restore"
restore_path_atomically "$backup_real/release" "$NAV_PROJECT_DIR" release
restore_path_atomically "$backup_real/frontend" "$NAV_FRONTEND_DIR" frontend

declare -A allowed_targets=()
for target_list in "$NAV_COMPOSE_PATHS" "$NAV_NGINX_PATHS" "$NAV_ENV_PATHS" "$NAV_EXTRA_CONFIG_PATHS" "$NAV_OUTER_PROXY_PATHS"; do
  targets=()
  split_list "$target_list" targets
  for target in "${targets[@]}"; do
    [[ -n "$target" ]] || continue
    safe_target "$target"
    normalized_target="$(realpath -e -- "$target" 2>/dev/null || printf '%s' "$target")"
    allowed_targets["$normalized_target"]=1
  done
done
normalized_config="$(realpath -e -- "$CONFIG_FILE")"
allowed_targets["$normalized_config"]=1

CURRENT_STAGE="configuration and outer proxy restore"
while IFS=$'\t' read -r target relative || [[ -n "${target:-}" ]]; do
  [[ "$target" == "source" && "$relative" == "backup_path" ]] && continue
  [[ "$relative" == "frontend/" || "$relative" == "release/" ]] && continue
  [[ -n "$target" && -n "$relative" ]] || fatal "$EX_VERIFY" "invalid backup inventory row"
  [[ -n "${allowed_targets[$target]:-}" ]] \
    || fatal "$EX_CONFIG" "backup inventory target is not explicitly configured: $target"
  [[ "$relative" == config/* && "$relative" != *'..'* && "$relative" != /* ]] \
    || fatal "$EX_VERIFY" "unsafe backup inventory path: $relative"
  restore_path_atomically "$backup_real/$relative" "$target" config
done < "$backup_real/metadata/inventory.tsv"

CURRENT_STAGE="NPM SQLite restore"
safe_target "$NAV_NPM_SQLITE_PATH"
normalized_npm_sqlite="$(realpath -e -- "$NAV_NPM_SQLITE_PATH" 2>/dev/null || printf '%s' "$NAV_NPM_SQLITE_PATH")"
[[ "$(cat "$backup_real/proxy/npm-database.target")" == "$normalized_npm_sqlite" ]] \
  || fatal "$EX_CONFIG" "NPM SQLite restore target differs from the backup"
[[ "$(sqlite3 "$backup_real/proxy/npm-database.sqlite" 'PRAGMA quick_check;')" == "ok" ]] \
  || fatal "$EX_VERIFY" "backup NPM SQLite database failed integrity validation"
restore_path_atomically "$backup_real/proxy/npm-database.sqlite" "$NAV_NPM_SQLITE_PATH" npm-sqlite

CURRENT_STAGE="PostgreSQL startup"
if ! container_exists "$NAV_DB_CONTAINER"; then
  [[ -n "$NAV_DR_COMPOSE_FILE" && -n "$NAV_DR_COMPOSE_PROJECT_DIR" ]] \
    || fatal "$EX_CONFIG" "a clean host requires NAV_DR_COMPOSE_FILE and NAV_DR_COMPOSE_PROJECT_DIR"
  compose_up \
    "$NAV_DR_COMPOSE_PROJECT_DIR" \
    "$NAV_DR_COMPOSE_FILE" \
    "$NAV_DR_DATABASE_SERVICE"
fi
container_running "$NAV_DB_CONTAINER" || docker start "$NAV_DB_CONTAINER" >/dev/null
wait_for_postgres

table_count="$(docker exec "$NAV_DB_CONTAINER" psql -X -q -At \
  -U "$NAV_DB_USER" -d "$NAV_DB_NAME" -c \
  "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');")"
[[ "$table_count" =~ ^[0-9]+$ ]] || fatal "$EX_SOFTWARE" "could not inspect target PostgreSQL database"
if ((table_count > 0)) && ! "$REQUEST_REPLACE"; then
  fatal "$EX_CONFIG" "target PostgreSQL is not empty; rerun with the separately gated --replace-existing"
fi

CURRENT_STAGE="PostgreSQL restore"
DATABASE_CHANGED=true
restore_database_dump "$backup_real/database/nav.dump" \
  || fatal "$EX_SOFTWARE" "PostgreSQL restore failed"

CURRENT_STAGE="image object restore"
IMAGE_CHANGED=true
if "$REQUEST_IMAGE_SYNC"; then
  rclone --config "$NAV_IMAGE_RCLONE_CONFIG" sync \
    "$backup_real/image-objects" "$NAV_IMAGE_RCLONE_REMOTE" --metadata
else
  rclone --config "$NAV_IMAGE_RCLONE_CONFIG" copy \
    "$backup_real/image-objects" "$NAV_IMAGE_RCLONE_REMOTE" --metadata
fi
rclone --config "$NAV_IMAGE_RCLONE_CONFIG" check \
  "$backup_real/image-objects" "$NAV_IMAGE_RCLONE_REMOTE" --one-way --size-only

CURRENT_STAGE="proxy startup"
if [[ -n "$NAV_DR_PROXY_COMPOSE_FILE" ]]; then
  compose_up \
    "$NAV_DR_PROXY_COMPOSE_PROJECT_DIR" \
    "$NAV_DR_PROXY_COMPOSE_FILE" \
    "$NAV_DR_PROXY_COMPOSE_SERVICES"
else
  restore_previously_running_containers
fi

CURRENT_STAGE="NAV application startup"
compose_up \
  "$NAV_DR_COMPOSE_PROJECT_DIR" \
  "$NAV_DR_COMPOSE_FILE" \
  "$NAV_DR_COMPOSE_SERVICES"
restore_previously_running_containers

CURRENT_STAGE="health acceptance"
health_urls=()
split_list "$NAV_DR_HEALTH_URLS" health_urls
for health_url in "${health_urls[@]}"; do
  [[ -n "$health_url" ]] || continue
  [[ "$health_url" == https://* ]] || fatal "$EX_CONFIG" "health URL must use HTTPS"
  curl --fail --silent --show-error --location \
    --max-time 20 --retry 3 --retry-all-errors "$health_url" >/dev/null \
    || fatal "$EX_SOFTWARE" "health acceptance failed: $health_url"
done

ROLLBACK_ARMED=false
CURRENT_STAGE="complete"
log "complete disaster restore passed: $backup_real"
log "rollback evidence retained at: $ROLLBACK_DIR"
exit 0
