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
readonly CANONICAL_BACKUP_LOCK_FILE='/run/lock/nav-backup.lock'

PROGRAM_NAME="$(basename "$0")"
CONFIG_FILE="${NAV_BACKUP_CONFIG:-/etc/nav/nav-backup.env}"
CLI_DRY_RUN=false
DRY_RUN=false
REQUEST_CLOUD_UPLOAD=false
REQUEST_LOCAL_PRUNE=false
REQUEST_CLOUD_FORGET=false
CURRENT_STAGE="initialization"
STAGING_DIR=""
FINAL_DIR=""
CLOUD_WORK_DIR=""
RESTIC_EVIDENCE_STAGING=""
SNAPSHOT_HOLDER_PID=""
SNAPSHOT_HOLDER_READ_FD=""
SNAPSHOT_HOLDER_WRITE_FD=""
SNAPSHOT_ID=""
LOCK_FD=9

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  nav-backup.sh [--config FILE] [--dry-run]
                [--cloud-upload] [--prune-local] [--forget-cloud]

Safety gates:
  --cloud-upload requires NAV_ENABLE_CLOUD_UPLOAD=true.
  --prune-local requires NAV_ENABLE_LOCAL_PRUNE=true.
  --forget-cloud requires --cloud-upload and NAV_ENABLE_RESTIC_FORGET=true.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

require_uint() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fatal "$EX_CONFIG" "$name must be a non-negative integer"
}

assert_safe_settings_file() {
  local path="$1"
  local exact_mode="${2:-}"
  local mode owner

  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "settings file path must be absolute: $path"
  [[ -f "$path" && ! -L "$path" ]] || fatal "$EX_CONFIG" "settings file must be a regular non-symlink file: $path"

  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  [[ "$owner" == "$EUID" ]] || fatal "$EX_CONFIG" "settings file must be owned by uid $EUID: $path"

  if [[ -n "$exact_mode" ]]; then
    [[ "$mode" == "$exact_mode" ]] || fatal "$EX_CONFIG" "settings file must have mode $exact_mode: $path"
  else
    (( (8#$mode & 022) == 0 )) || fatal "$EX_CONFIG" "settings file must not be group/world writable: $path"
  fi
}

read_telegram_credentials() {
  local path="$1"
  local line key value mode owner
  TELEGRAM_BOT_TOKEN_VALUE=""
  TELEGRAM_CHAT_ID_VALUE=""

  if [[ "$path" != /* || ! -f "$path" || -L "$path" ]]; then
    log "Telegram credential file must be an absolute regular non-symlink file"
    return 1
  fi
  mode="$(stat -c '%a' -- "$path" 2>/dev/null || true)"
  owner="$(stat -c '%u' -- "$path" 2>/dev/null || true)"
  if [[ "$mode" != "600" || "$owner" != "$EUID" ]]; then
    log "Telegram credential file must be owned by uid $EUID with mode 600"
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      log "invalid Telegram credential line"
      return 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      TELEGRAM_BOT_TOKEN) TELEGRAM_BOT_TOKEN_VALUE="$value" ;;
      TELEGRAM_CHAT_ID) TELEGRAM_CHAT_ID_VALUE="$value" ;;
      *)
        log "unsupported key in Telegram credential file: $key"
        return 1
        ;;
    esac
  done < "$path"

  if [[ ! "$TELEGRAM_BOT_TOKEN_VALUE" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
    log "Telegram credential file has an invalid bot token"
    return 1
  fi
  if [[ ! "$TELEGRAM_CHAT_ID_VALUE" =~ ^-?[0-9]+$ ]]; then
    log "Telegram credential file has an invalid chat id"
    return 1
  fi
}

send_failure_alert() {
  local exit_code="$1"
  local message="$2"
  local alert_text

  "$DRY_RUN" && return 0
  is_true "${NAV_ENABLE_TELEGRAM_ALERTS:-false}" || return 0

  if ! command -v curl >/dev/null 2>&1; then
    log "Telegram alert skipped: curl is unavailable"
    return 0
  fi

  if ! read_telegram_credentials "${NAV_TELEGRAM_CREDENTIAL_FILE:-}"; then
    log "Telegram alert skipped: credential validation failed"
    return 0
  fi

  alert_text="DOMO NAV backup failed
host: $(hostname -f 2>/dev/null || hostname)
stage: $CURRENT_STAGE
exit: $exit_code
time: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
detail: $message"

  # The bot token is supplied to curl through its stdin-backed config, never
  # through argv (and therefore never through /proc/<pid>/cmdline).
  if ! curl -q --config - \
    --fail --silent --show-error \
    --max-time "${NAV_TELEGRAM_TIMEOUT_SECONDS:-10}" \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID_VALUE" \
    --data-urlencode "text=$alert_text" \
    >/dev/null <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_VALUE}/sendMessage"
EOF
  then
    log "Telegram alert delivery failed"
  fi

  TELEGRAM_BOT_TOKEN_VALUE=""
  TELEGRAM_CHAT_ID_VALUE=""
}

cleanup_snapshot_holder() {
  local holder_pid="$SNAPSHOT_HOLDER_PID"

  [[ -n "$holder_pid" ]] || return 0
  if kill -0 "$holder_pid" >/dev/null 2>&1; then
    if [[ -n "$SNAPSHOT_HOLDER_WRITE_FD" ]]; then
      { printf '%s\n' 'ROLLBACK;' '\q' >&"$SNAPSHOT_HOLDER_WRITE_FD"; } 2>/dev/null || true
    fi
    wait "$holder_pid" 2>/dev/null || true
  fi
  SNAPSHOT_HOLDER_PID=""
  SNAPSHOT_HOLDER_READ_FD=""
  SNAPSHOT_HOLDER_WRITE_FD=""
  SNAPSHOT_ID=""
}

cleanup_staging() {
  local root_real staging_real
  [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]] || return 0

  root_real="$(realpath -e -- "$NAV_BACKUP_ROOT" 2>/dev/null || true)"
  staging_real="$(realpath -e -- "$STAGING_DIR" 2>/dev/null || true)"
  if [[ -n "$root_real" && "$staging_real" == "$root_real"/.nav-backup.* ]]; then
    rm -rf -- "$staging_real"
  else
    log "refused to remove unverified staging path: $STAGING_DIR"
  fi
  STAGING_DIR=""
}

cleanup_cloud_work() {
  local work_real parent_real
  [[ -n "$CLOUD_WORK_DIR" && -d "$CLOUD_WORK_DIR" ]] || return 0

  work_real="$(realpath -e -- "$CLOUD_WORK_DIR" 2>/dev/null || true)"
  parent_real="$(realpath -e -- "$(dirname "$CLOUD_WORK_DIR")" 2>/dev/null || true)"
  if [[ -n "$work_real" && "$work_real" == "$parent_real"/nav-restic-evidence.* ]]; then
    rm -rf -- "$work_real"
  else
    log "refused to remove unverified restic work path: $CLOUD_WORK_DIR"
  fi
  CLOUD_WORK_DIR=""
}

cleanup_restic_evidence_staging() {
  local staging_real parent_real
  [[ -n "$RESTIC_EVIDENCE_STAGING" && -d "$RESTIC_EVIDENCE_STAGING" ]] || return 0

  staging_real="$(realpath -e -- "$RESTIC_EVIDENCE_STAGING" 2>/dev/null || true)"
  parent_real="$(realpath -e -- "$(dirname "$RESTIC_EVIDENCE_STAGING")" 2>/dev/null || true)"
  if [[ -n "$staging_real" && "$staging_real" == "$parent_real"/.nav-restic-evidence.* ]]; then
    rm -rf -- "$staging_real"
  else
    log "refused to remove unverified restic evidence staging path: $RESTIC_EVIDENCE_STAGING"
  fi
  RESTIC_EVIDENCE_STAGING=""
}

fatal() {
  local exit_code="$1"
  shift
  local message="$*"

  trap - ERR
  log "ERROR: $message"
  cleanup_snapshot_holder || true
  send_failure_alert "$exit_code" "$message" || true
  cleanup_staging || true
  cleanup_cloud_work || true
  cleanup_restic_evidence_staging || true
  exit "$exit_code"
}

handle_error() {
  local original_code="$1"
  local line="$2"
  local mapped_code="$original_code"

  if (( mapped_code < 64 || mapped_code > 125 )); then
    mapped_code="$EX_SOFTWARE"
  fi
  fatal "$mapped_code" "unexpected command failure at line $line (original exit $original_code)"
}

trap 'handle_error "$?" "$LINENO"' ERR
trap 'cleanup_snapshot_holder || true; cleanup_staging || true; cleanup_cloud_work || true; cleanup_restic_evidence_staging || true' EXIT
trap 'fatal 130 "interrupted by signal"' INT TERM

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --dry-run)
      CLI_DRY_RUN=true
      shift
      ;;
    --cloud-upload)
      REQUEST_CLOUD_UPLOAD=true
      shift
      ;;
    --prune-local)
      REQUEST_LOCAL_PRUNE=true
      shift
      ;;
    --forget-cloud)
      REQUEST_CLOUD_FORGET=true
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

if is_true "${NAV_ACCEPTANCE_EPHEMERAL:-false}"; then
  fatal "$EX_CONFIG" 'backup must run outside the release acceptance lifecycle'
fi

assert_safe_settings_file "$CONFIG_FILE"
# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${NAV_BACKUP_ROOT:=/var/backups/nav}"
: "${NAV_BACKUP_LOCK_FILE:=$CANONICAL_BACKUP_LOCK_FILE}"
: "${NAV_DB_CONTAINER:=nav-postgres}"
: "${NAV_DB_NAME:=nav}"
: "${NAV_DB_USER:=nav}"
: "${NAV_PG_SNAPSHOT_TIMEOUT_SECONDS:=30}"
: "${NAV_PROJECT_DIR:=/opt/nav}"
: "${NAV_FRONTEND_DIR:=/home/web/html/nav}"
: "${NAV_COMPOSE_PATHS:=}"
: "${NAV_NGINX_PATHS:=}"
: "${NAV_ENV_PATHS:=}"
: "${NAV_EXTRA_CONFIG_PATHS:=}"
: "${NAV_OUTER_PROXY_PATHS:=}"
: "${NAV_RUNTIME_CONTAINERS:=nav-api;nav-postgres}"
: "${NAV_REQUIRE_ALL_INPUTS:=true}"
: "${NAV_ENABLE_IMAGE_OBJECT_BACKUP:=false}"
: "${NAV_IMAGE_RCLONE_CONFIG:=/etc/nav/imgbed-rclone.conf}"
: "${NAV_IMAGE_RCLONE_REMOTE:=}"
: "${NAV_ENABLE_OUTER_PROXY_BACKUP:=false}"
: "${NAV_NPM_SQLITE_PATH:=}"
: "${NAV_ENABLE_LOCAL_PRUNE:=false}"
: "${NAV_LOCAL_KEEP_DAYS:=30}"
: "${NAV_LOCAL_KEEP_COUNT:=14}"
: "${NAV_ENABLE_TELEGRAM_ALERTS:=false}"
: "${NAV_TELEGRAM_CREDENTIAL_FILE:=/etc/nav/backup-telegram.env}"
: "${NAV_TELEGRAM_TIMEOUT_SECONDS:=10}"
: "${NAV_ENABLE_CLOUD_UPLOAD:=false}"
: "${NAV_RESTIC_ENV_FILE:=/etc/nav/restic-r2.env}"
: "${NAV_RESTIC_EVIDENCE_DIR:=/var/backups/nav-restic-evidence}"
: "${NAV_RESTIC_TAG:=domo-nav}"
: "${NAV_RESTIC_RUN_CHECK:=true}"
: "${NAV_ENABLE_RESTIC_FORGET:=false}"
: "${NAV_RESTIC_KEEP_DAILY:=14}"
: "${NAV_RESTIC_KEEP_WEEKLY:=8}"
: "${NAV_RESTIC_KEEP_MONTHLY:=12}"
: "${NAV_DRY_RUN:=false}"

if is_true "$NAV_DRY_RUN" || "$CLI_DRY_RUN"; then
  DRY_RUN=true
else
  DRY_RUN=false
fi

[[ "$NAV_BACKUP_ROOT" == /* ]] || fatal "$EX_CONFIG" "NAV_BACKUP_ROOT must be absolute"
[[ "$NAV_BACKUP_LOCK_FILE" == "$CANONICAL_BACKUP_LOCK_FILE" ]] \
  || fatal "$EX_CONFIG" "NAV_BACKUP_LOCK_FILE must remain $CANONICAL_BACKUP_LOCK_FILE"
[[ "$NAV_FRONTEND_DIR" == /* ]] || fatal "$EX_CONFIG" "NAV_FRONTEND_DIR must be absolute"
[[ "$NAV_PROJECT_DIR" == /* ]] || fatal "$EX_CONFIG" "NAV_PROJECT_DIR must be absolute"
[[ "$NAV_RESTIC_EVIDENCE_DIR" == /* ]] || fatal "$EX_CONFIG" "NAV_RESTIC_EVIDENCE_DIR must be absolute"
[[ "$NAV_DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fatal "$EX_CONFIG" "invalid NAV_DB_CONTAINER"
[[ "$NAV_DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fatal "$EX_CONFIG" "invalid NAV_DB_NAME"
[[ "$NAV_DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fatal "$EX_CONFIG" "invalid NAV_DB_USER"
[[ "$NAV_RESTIC_TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || fatal "$EX_CONFIG" "invalid NAV_RESTIC_TAG"
if is_true "$NAV_ENABLE_IMAGE_OBJECT_BACKUP"; then
  [[ "$NAV_IMAGE_RCLONE_CONFIG" == /* ]] \
    || fatal "$EX_CONFIG" "NAV_IMAGE_RCLONE_CONFIG must be absolute"
  [[ -n "$NAV_IMAGE_RCLONE_REMOTE" && "$NAV_IMAGE_RCLONE_REMOTE" != *$'\n'* && "$NAV_IMAGE_RCLONE_REMOTE" != *$'\r'* ]] \
    || fatal "$EX_CONFIG" "NAV_IMAGE_RCLONE_REMOTE must name one rclone remote path"
fi
if is_true "$NAV_ENABLE_OUTER_PROXY_BACKUP"; then
  [[ "$NAV_NPM_SQLITE_PATH" == /* ]] \
    || fatal "$EX_CONFIG" "NAV_NPM_SQLITE_PATH must be absolute when outer proxy backup is enabled"
  [[ -n "$NAV_OUTER_PROXY_PATHS" ]] \
    || fatal "$EX_CONFIG" "NAV_OUTER_PROXY_PATHS is required when outer proxy backup is enabled"
fi

require_uint NAV_LOCAL_KEEP_DAYS "$NAV_LOCAL_KEEP_DAYS"
require_uint NAV_LOCAL_KEEP_COUNT "$NAV_LOCAL_KEEP_COUNT"
require_uint NAV_PG_SNAPSHOT_TIMEOUT_SECONDS "$NAV_PG_SNAPSHOT_TIMEOUT_SECONDS"
require_uint NAV_TELEGRAM_TIMEOUT_SECONDS "$NAV_TELEGRAM_TIMEOUT_SECONDS"
require_uint NAV_RESTIC_KEEP_DAILY "$NAV_RESTIC_KEEP_DAILY"
require_uint NAV_RESTIC_KEEP_WEEKLY "$NAV_RESTIC_KEEP_WEEKLY"
require_uint NAV_RESTIC_KEEP_MONTHLY "$NAV_RESTIC_KEEP_MONTHLY"
(( NAV_PG_SNAPSHOT_TIMEOUT_SECONDS > 0 )) \
  || fatal "$EX_CONFIG" "NAV_PG_SNAPSHOT_TIMEOUT_SECONDS must be greater than zero"

"$REQUEST_CLOUD_UPLOAD" && ! is_true "$NAV_ENABLE_CLOUD_UPLOAD" \
  && fatal "$EX_CONFIG" "--cloud-upload requires NAV_ENABLE_CLOUD_UPLOAD=true"
"$REQUEST_LOCAL_PRUNE" && ! is_true "$NAV_ENABLE_LOCAL_PRUNE" \
  && fatal "$EX_CONFIG" "--prune-local requires NAV_ENABLE_LOCAL_PRUNE=true"
"$REQUEST_CLOUD_FORGET" && { ! "$REQUEST_CLOUD_UPLOAD" || ! is_true "$NAV_ENABLE_RESTIC_FORGET"; } \
  && fatal "$EX_CONFIG" "--forget-cloud requires --cloud-upload and NAV_ENABLE_RESTIC_FORGET=true"

CURRENT_STAGE="dependency checks"
for command_name in stat realpath flock find sort sha256sum cp mv mktemp awk install xargs sed grep cmp readlink python3 wc; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done
if is_true "$NAV_ENABLE_IMAGE_OBJECT_BACKUP"; then
  command -v rclone >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "rclone is required for image-object backup"
  assert_safe_settings_file "$NAV_IMAGE_RCLONE_CONFIG" 600
fi
if is_true "$NAV_ENABLE_OUTER_PROXY_BACKUP"; then
  command -v sqlite3 >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "sqlite3 is required for outer-proxy backup"
fi

if ! "$DRY_RUN"; then
  command -v docker >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "docker is required"
fi
if "$REQUEST_CLOUD_UPLOAD"; then
  command -v jq >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "jq is required for exact restic snapshot verification"
fi

split_paths() {
  local list="$1"
  local -n result_ref="$2"
  # ShellCheck cannot see that this nameref populates the caller's array.
  # shellcheck disable=SC2034
  IFS=';' read -r -a result_ref <<< "$list"
}

validate_input_path() {
  local path="$1"
  local description="$2"

  [[ -n "$path" ]] || return 0
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] \
    || fatal "$EX_CONFIG" "$description path contains a control character"
  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "$description path must be absolute: $path"
  if [[ ! -e "$path" ]]; then
    if is_true "$NAV_REQUIRE_ALL_INPUTS"; then
      fatal "$EX_CONFIG" "$description path does not exist: $path"
    fi
    log "warning: skipped missing $description path: $path"
    return 1
  fi
  return 0
}

validate_path_list() {
  local description="$1"
  local list="$2"
  local paths=()
  local path
  split_paths "$list" paths
  for path in "${paths[@]}"; do
    [[ -z "$path" ]] && continue
    validate_input_path "$path" "$description" || true
  done
}

validate_input_path "$NAV_FRONTEND_DIR" "frontend"
validate_input_path "$NAV_PROJECT_DIR" "project"
validate_path_list "Compose" "$NAV_COMPOSE_PATHS"
validate_path_list "Nginx" "$NAV_NGINX_PATHS"
validate_path_list "environment" "$NAV_ENV_PATHS"
validate_path_list "extra configuration" "$NAV_EXTRA_CONFIG_PATHS"
validate_path_list "outer proxy" "$NAV_OUTER_PROXY_PATHS"
if is_true "$NAV_ENABLE_OUTER_PROXY_BACKUP"; then
  validate_input_path "$NAV_NPM_SQLITE_PATH" "NPM SQLite database"
fi

if "$DRY_RUN"; then
  log "dry-run plan"
  log "backup root: $NAV_BACKUP_ROOT"
  log "database: container=$NAV_DB_CONTAINER database=$NAV_DB_NAME user=$NAV_DB_USER"
  log "frontend: $NAV_FRONTEND_DIR"
  log "image objects configured: $(is_true "$NAV_ENABLE_IMAGE_OBJECT_BACKUP" && echo true || echo false)"
  log "outer proxy configured: $(is_true "$NAV_ENABLE_OUTER_PROXY_BACKUP" && echo true || echo false)"
  log "cloud upload requested/configured: $REQUEST_CLOUD_UPLOAD/$(is_true "$NAV_ENABLE_CLOUD_UPLOAD" && echo true || echo false)"
  log "local prune requested/configured: $REQUEST_LOCAL_PRUNE/$(is_true "$NAV_ENABLE_LOCAL_PRUNE" && echo true || echo false)"
  log "cloud forget requested/configured: $REQUEST_CLOUD_FORGET/$(is_true "$NAV_ENABLE_RESTIC_FORGET" && echo true || echo false)"
  log "dry-run complete; no dump, copy, container, cloud write, or deletion was performed"
  exit 0
fi

[[ "$EUID" == 0 ]] || fatal "$EX_CONFIG" "canonical NAV backup must run as root"
[[ -d /run && ! -L /run && "$(realpath -e -- /run)" == /run ]] \
  || fatal "$EX_CONFIG" "/run is unavailable or unsafe"
[[ "$(stat -c '%u' -- /run)" == 0 ]] \
  || fatal "$EX_CONFIG" "/run must be root-owned"
if [[ ! -e /run/lock && ! -L /run/lock ]]; then
  install -d -m 0755 -- /run/lock
fi
[[ -d /run/lock && ! -L /run/lock && "$(realpath -e -- /run/lock)" == /run/lock ]] \
  || fatal "$EX_CONFIG" "canonical backup lock parent is unsafe"
[[ "$(stat -c '%u' -- /run/lock)" == 0 ]] \
  || fatal "$EX_CONFIG" "canonical backup lock parent must be root-owned"
lock_parent_mode="$(stat -c '%a' -- /run/lock)"
(( (8#$lock_parent_mode & 022) == 0 || (8#$lock_parent_mode & 01000) != 0 )) \
  || fatal "$EX_CONFIG" "writable canonical backup lock parent must have the sticky bit"
python3 - "$NAV_BACKUP_LOCK_FILE" <<'PY' \
  || fatal "$EX_CONFIG" "canonical backup lock is unsafe"
import os
import stat
import sys

path = sys.argv[1]
flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
fd = os.open(path, flags, 0o600)
try:
    descriptor = os.fstat(fd)
    path_stat = os.lstat(path)
    if not stat.S_ISREG(descriptor.st_mode) or stat.S_ISLNK(path_stat.st_mode):
        raise SystemExit(1)
    if descriptor.st_uid != 0 or descriptor.st_ino != path_stat.st_ino or descriptor.st_dev != path_stat.st_dev:
        raise SystemExit(1)
    if stat.S_IMODE(descriptor.st_mode) & 0o022:
        raise SystemExit(1)
    os.fchmod(fd, 0o600)
finally:
    os.close(fd)
PY
exec 9>>"$NAV_BACKUP_LOCK_FILE"
chmod 0600 "$NAV_BACKUP_LOCK_FILE"
flock -n "$LOCK_FD" || fatal "$EX_TEMPFAIL" "another NAV backup is already running"

CURRENT_STAGE="backup workspace creation"
[[ ! -L "$NAV_BACKUP_ROOT" ]] || fatal "$EX_CONFIG" "backup root must not be a symlink"
install -d -m 0700 -- "$NAV_BACKUP_ROOT" \
  || fatal "$EX_CANTCREAT" "cannot create backup root"

backup_root_real="$(realpath -e -- "$NAV_BACKUP_ROOT")"
frontend_real="$(realpath -e -- "$NAV_FRONTEND_DIR")"
[[ "$frontend_real" != "/" ]] || fatal "$EX_CONFIG" "frontend path must not be the filesystem root"
[[ "$frontend_real" != "$backup_root_real" && "$frontend_real" != "$backup_root_real"/* ]] \
  || fatal "$EX_CONFIG" "frontend path must not be inside the backup root"

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
commit_id="nogit"
if command -v git >/dev/null 2>&1 && git -C "$NAV_PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  commit_id="$(git -C "$NAV_PROJECT_DIR" rev-parse --short=12 HEAD)"
fi
final_name="nav-${timestamp}-${commit_id}"
FINAL_DIR="$NAV_BACKUP_ROOT/$final_name"
[[ ! -e "$FINAL_DIR" ]] || fatal "$EX_CANTCREAT" "backup destination already exists: $FINAL_DIR"

STAGING_DIR="$(mktemp -d "$NAV_BACKUP_ROOT/.nav-backup.XXXXXXXX")"
chmod 0700 "$STAGING_DIR"
install -d -m 0700 \
  "$STAGING_DIR/database" \
  "$STAGING_DIR/frontend" \
  "$STAGING_DIR/release" \
  "$STAGING_DIR/image-objects" \
  "$STAGING_DIR/config/compose" \
  "$STAGING_DIR/config/nginx" \
  "$STAGING_DIR/config/environment" \
  "$STAGING_DIR/config/extra" \
  "$STAGING_DIR/config/proxy" \
  "$STAGING_DIR/proxy" \
  "$STAGING_DIR/metadata" \
  "$STAGING_DIR/attachments"

inventory_file="$STAGING_DIR/metadata/inventory.tsv"
printf 'source\tbackup_path\n' > "$inventory_file"

safe_copy_path() {
  local source="$1"
  local category="$2"
  local source_real label digest destination

  validate_input_path "$source" "$category" || return 0
  source_real="$(realpath -e -- "$source")"
  [[ "$source_real" != "/" ]] || fatal "$EX_CONFIG" "refused to copy the filesystem root"
  [[ "$source_real" != "$backup_root_real" && "$source_real" != "$backup_root_real"/* ]] \
    || fatal "$EX_CONFIG" "refused to copy a path inside the backup root: $source"
  if [[ "$category" == "environment" ]]; then
    local source_mode
    [[ -f "$source_real" ]] || fatal "$EX_CONFIG" "environment input must be a regular file: $source"
    source_mode="$(stat -c '%a' -- "$source_real")"
    (( (8#$source_mode & 077) == 0 )) \
      || fatal "$EX_CONFIG" "environment input must not be group/world accessible: $source"
  fi
  label="$(basename "$source")"
  digest="$(printf '%s' "$source_real" | sha256sum | awk '{print substr($1,1,12)}')"
  destination="$STAGING_DIR/config/$category/${label}.${digest}"

  # realpath resolves an explicitly configured top-level symlink (for example
  # sites-enabled -> sites-available) without recursively following unrelated
  # symlinks inside a configured directory.
  cp -a -- "$source_real" "$destination"
  chmod -R go-rwx -- "$destination"
  printf '%s\t%s\n' "$source_real" "${destination#"$STAGING_DIR"/}" >> "$inventory_file"
}

copy_path_list() {
  local category="$1"
  local list="$2"
  local paths=()
  local path
  split_paths "$list" paths
  for path in "${paths[@]}"; do
    [[ -z "$path" ]] && continue
    safe_copy_path "$path" "$category"
  done
}

start_snapshot_holder() {
  local guard_status marker_count user_count
  CURRENT_STAGE="PostgreSQL snapshot export"
  coproc NAV_SNAPSHOT_HOLDER {
    docker exec -i "$NAV_DB_CONTAINER" \
      psql -X -q -v ON_ERROR_STOP=1 \
      -U "$NAV_DB_USER" -d "$NAV_DB_NAME" -At
  }
  SNAPSHOT_HOLDER_PID="$NAV_SNAPSHOT_HOLDER_PID"
  SNAPSHOT_HOLDER_READ_FD="${NAV_SNAPSHOT_HOLDER[0]}"
  SNAPSHOT_HOLDER_WRITE_FD="${NAV_SNAPSHOT_HOLDER[1]}"

  printf '%s\n' \
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
    "SELECT 'locked'
       FROM (
         SELECT pg_advisory_xact_lock(
           hashtext(current_database()),
           hashtext('nav_release_acceptance_account')
         )
       ) AS acceptance_guard;" \
    "SELECT concat(
       (SELECT count(*) FROM public.system_settings
         WHERE LEFT(key, LENGTH('release_acceptance_account:')) = 'release_acceptance_account:'),
       E'\\t',
       (SELECT count(*) FROM public.users
         WHERE LEFT(username, LENGTH('nav_release_accept_')) = 'nav_release_accept_')
     );" \
    'SELECT pg_export_snapshot();' \
    >&"$SNAPSHOT_HOLDER_WRITE_FD" \
    || fatal "$EX_SOFTWARE" "could not request a PostgreSQL exported snapshot"

  if ! IFS= read -r -t "$NAV_PG_SNAPSHOT_TIMEOUT_SECONDS" guard_status \
    <&"$SNAPSHOT_HOLDER_READ_FD"; then
    fatal "$EX_TEMPFAIL" "timed out waiting for the release acceptance advisory lock"
  fi
  [[ "$guard_status" == locked ]] \
    || fatal "$EX_SOFTWARE" "PostgreSQL did not confirm the release acceptance advisory lock"

  if ! IFS=$'\t' read -r -t "$NAV_PG_SNAPSHOT_TIMEOUT_SECONDS" marker_count user_count \
    <&"$SNAPSHOT_HOLDER_READ_FD"; then
    fatal "$EX_TEMPFAIL" "timed out waiting for the release acceptance backup gate"
  fi
  [[ "$marker_count" =~ ^[0-9]+$ && "$user_count" =~ ^[0-9]+$ ]] \
    || fatal "$EX_SOFTWARE" "PostgreSQL returned invalid release acceptance residue counts"
  if ((marker_count != 0 || user_count != 0)); then
    fatal "$EX_TEMPFAIL" "release acceptance residue blocks database backup"
  fi

  if ! IFS= read -r -t "$NAV_PG_SNAPSHOT_TIMEOUT_SECONDS" SNAPSHOT_ID \
    <&"$SNAPSHOT_HOLDER_READ_FD"; then
    fatal "$EX_TEMPFAIL" "timed out waiting for PostgreSQL exported snapshot"
  fi
  [[ "$SNAPSHOT_ID" =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9A-Fa-f]+$ ]] \
    || fatal "$EX_SOFTWARE" "PostgreSQL returned an invalid exported snapshot identifier"
}

run_snapshot_sql() {
  local sql="$1"
  [[ -n "$SNAPSHOT_ID" ]] || fatal "$EX_SOFTWARE" "database snapshot is not active"
  docker exec "$NAV_DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 \
    -U "$NAV_DB_USER" -d "$NAV_DB_NAME" -Atc \
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
     SET TRANSACTION SNAPSHOT '$SNAPSHOT_ID';
     $sql
     COMMIT;"
}

finish_snapshot_holder() {
  local holder_pid="$SNAPSHOT_HOLDER_PID"
  [[ -n "$holder_pid" ]] || fatal "$EX_SOFTWARE" "database snapshot holder is not active"

  printf '%s\n' 'COMMIT;' '\q' >&"$SNAPSHOT_HOLDER_WRITE_FD" \
    || fatal "$EX_SOFTWARE" "could not close PostgreSQL snapshot transaction"
  if ! wait "$holder_pid"; then
    fatal "$EX_SOFTWARE" "PostgreSQL snapshot holder exited unsuccessfully"
  fi
  SNAPSHOT_HOLDER_PID=""
  SNAPSHOT_HOLDER_READ_FD=""
  SNAPSHOT_HOLDER_WRITE_FD=""
  SNAPSHOT_ID=""
}

start_snapshot_holder
printf '%s\n' "$SNAPSHOT_ID" > "$STAGING_DIR/database/snapshot-id.txt"

CURRENT_STAGE="PostgreSQL custom-format dump from exported snapshot"
database_dump="$STAGING_DIR/database/nav.dump"
if ! docker exec "$NAV_DB_CONTAINER" \
  pg_dump -U "$NAV_DB_USER" -d "$NAV_DB_NAME" \
  -Fc -Z 6 --no-owner --no-acl --snapshot="$SNAPSHOT_ID" > "$database_dump"; then
  fatal "$EX_SOFTWARE" "pg_dump failed"
fi
[[ -s "$database_dump" ]] || fatal "$EX_SOFTWARE" "pg_dump produced an empty file"
chmod 0600 "$database_dump"

CURRENT_STAGE="database verification metadata"
public_tables_file="$STAGING_DIR/database/public-tables.txt"
run_snapshot_sql \
  "SELECT c.relname
     FROM pg_catalog.pg_class AS c
     JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
    ORDER BY c.relname;" > "$public_tables_file"
[[ -s "$public_tables_file" ]] \
  || fatal "$EX_SOFTWARE" "the exported snapshot contains no public tables"

printf 'table\trows\n' > "$STAGING_DIR/database/table-counts.tsv"
while IFS= read -r table_name || [[ -n "$table_name" ]]; do
  [[ "$table_name" =~ ^[a-z_][a-z0-9_]*$ ]] \
    || fatal "$EX_SOFTWARE" "unsupported public table identifier in snapshot: $table_name"
  row_count="$(run_snapshot_sql "SELECT count(*) FROM public.\"${table_name}\";")"
  [[ "$row_count" =~ ^[0-9]+$ ]] || fatal "$EX_SOFTWARE" "invalid row count for $table_name"
  printf '%s\t%s\n' "$table_name" "$row_count" >> "$STAGING_DIR/database/table-counts.tsv"
done < "$public_tables_file"

run_snapshot_sql \
  "COPY (
     SELECT id,
            name,
            executed_at AT TIME ZONE 'UTC' AS executed_at_utc
       FROM public.schema_migrations
      ORDER BY id, name
   ) TO STDOUT WITH (FORMAT csv, DELIMITER E'\t', HEADER true, FORCE_QUOTE *);" \
  > "$STAGING_DIR/database/schema-migrations.tsv"
[[ -s "$STAGING_DIR/database/schema-migrations.tsv" ]] \
  || fatal "$EX_SOFTWARE" "schema_migrations evidence is empty"

run_snapshot_sql "SHOW server_version;" \
  > "$STAGING_DIR/database/postgresql-version.txt"

CURRENT_STAGE="attachment URL inventory"
if ! run_snapshot_sql \
  "SELECT DISTINCT attachment->>'url'
     FROM public.notes
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(attachments, '[]'::jsonb)) AS attachment
    WHERE NULLIF(attachment->>'url', '') IS NOT NULL
    ORDER BY 1;" \
  > "$STAGING_DIR/attachments/urls.txt"; then
  fatal "$EX_SOFTWARE" "attachment URL inventory failed"
fi

CURRENT_STAGE="PostgreSQL snapshot release"
finish_snapshot_holder

CURRENT_STAGE="pg_restore catalog validation"
if ! docker exec -i "$NAV_DB_CONTAINER" pg_restore -l \
  < "$database_dump" > "$STAGING_DIR/database/pg_restore.list"; then
  fatal "$EX_SOFTWARE" "pg_restore -l rejected the dump"
fi
[[ -s "$STAGING_DIR/database/pg_restore.list" ]] \
  || fatal "$EX_SOFTWARE" "pg_restore catalog is empty"

CURRENT_STAGE="frontend copy"
cp -a -- "$frontend_real"/. "$STAGING_DIR/frontend/"
chmod -R go-rwx -- "$STAGING_DIR/frontend"
printf '%s\t%s\n' "$frontend_real" "frontend/" >> "$inventory_file"

CURRENT_STAGE="release source copy"
project_real="$(realpath -e -- "$NAV_PROJECT_DIR")"
[[ "$project_real" != "/" ]] || fatal "$EX_CONFIG" "project path must not be the filesystem root"
[[ "$project_real" != "$backup_root_real" && "$project_real" != "$backup_root_real"/* ]] \
  || fatal "$EX_CONFIG" "project path must not be inside the backup root"
cp -a -- "$project_real"/. "$STAGING_DIR/release/"
chmod -R go-rwx -- "$STAGING_DIR/release"
printf '%s\t%s\n' "$project_real" "release/" >> "$inventory_file"

CURRENT_STAGE="configuration copy"
copy_path_list "compose" "$NAV_COMPOSE_PATHS"
copy_path_list "nginx" "$NAV_NGINX_PATHS"
copy_path_list "environment" "$NAV_ENV_PATHS"
copy_path_list "extra" "$NAV_EXTRA_CONFIG_PATHS"
safe_copy_path "$CONFIG_FILE" "extra"

printf 'component\tstatus\tdetail\n' > "$STAGING_DIR/metadata/disaster-components.tsv"

if is_true "$NAV_ENABLE_OUTER_PROXY_BACKUP"; then
  CURRENT_STAGE="outer proxy configuration copy"
  copy_path_list "proxy" "$NAV_OUTER_PROXY_PATHS"
  npm_sqlite_real="$(realpath -e -- "$NAV_NPM_SQLITE_PATH")"
  [[ -f "$npm_sqlite_real" && ! -L "$npm_sqlite_real" ]] \
    || fatal "$EX_CONFIG" "NPM SQLite database must be a regular non-symlink file"
  sqlite3 "$npm_sqlite_real" ".backup '$STAGING_DIR/proxy/npm-database.sqlite'" \
    || fatal "$EX_SOFTWARE" "NPM SQLite online backup failed"
  [[ "$(sqlite3 "$STAGING_DIR/proxy/npm-database.sqlite" 'PRAGMA quick_check;')" == "ok" ]] \
    || fatal "$EX_SOFTWARE" "NPM SQLite backup failed integrity validation"
  printf '%s\n' "$npm_sqlite_real" > "$STAGING_DIR/proxy/npm-database.target"
  chmod -R go-rwx -- "$STAGING_DIR/proxy"
  printf 'outer_proxy\tcomplete\tconfiguration_and_sqlite\n' \
    >> "$STAGING_DIR/metadata/disaster-components.tsv"
else
  printf 'outer_proxy\tnot_configured\tset_NAV_ENABLE_OUTER_PROXY_BACKUP\n' \
    >> "$STAGING_DIR/metadata/disaster-components.tsv"
fi

if is_true "$NAV_ENABLE_IMAGE_OBJECT_BACKUP"; then
  CURRENT_STAGE="image object copy"
  rclone --config "$NAV_IMAGE_RCLONE_CONFIG" copy \
    "$NAV_IMAGE_RCLONE_REMOTE" "$STAGING_DIR/image-objects" \
    --metadata --checkers 8 --transfers 4 \
    || fatal "$EX_SOFTWARE" "image-object copy failed"
  rclone --config "$NAV_IMAGE_RCLONE_CONFIG" lsf \
    "$NAV_IMAGE_RCLONE_REMOTE" --recursive --files-only --format sp --separator $'\t' \
    | sort > "$STAGING_DIR/metadata/image-objects-remote.tsv"
  find -P "$STAGING_DIR/image-objects" -type f -printf '%s\t%P\n' \
    | sort > "$STAGING_DIR/metadata/image-objects-local.tsv"
  cmp -s \
    "$STAGING_DIR/metadata/image-objects-remote.tsv" \
    "$STAGING_DIR/metadata/image-objects-local.tsv" \
    || fatal "$EX_SOFTWARE" "image-object path/size inventory differs after copy"
  image_object_count="$(wc -l < "$STAGING_DIR/metadata/image-objects-local.tsv")"
  printf 'image_objects\tcomplete\t%s_objects\n' "$image_object_count" \
    >> "$STAGING_DIR/metadata/disaster-components.tsv"
else
  printf 'image_objects\tnot_configured\tset_NAV_ENABLE_IMAGE_OBJECT_BACKUP\n' \
    >> "$STAGING_DIR/metadata/disaster-components.tsv"
fi

printf 'database\tcomplete\tpostgresql_custom_dump\n' \
  >> "$STAGING_DIR/metadata/disaster-components.tsv"
printf 'release\tcomplete\tsource_and_frontend\n' \
  >> "$STAGING_DIR/metadata/disaster-components.tsv"

CURRENT_STAGE="runtime and image inventory"
runtime_file="$STAGING_DIR/metadata/runtime.tsv"
printf 'key\tvalue\n' > "$runtime_file"
printf 'backup_utc\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> "$runtime_file"
printf 'hostname\t%s\n' "$(hostname -f 2>/dev/null || hostname)" >> "$runtime_file"
printf 'project_commit\t%s\n' "$commit_id" >> "$runtime_file"
printf 'kernel\t%s\n' "$(uname -srmo)" >> "$runtime_file"
printf 'docker_server\t%s\n' "$(docker version --format '{{.Server.Version}}')" >> "$runtime_file"
if command -v nginx >/dev/null 2>&1; then
  nginx_version="$(nginx -v 2>&1)"
  printf 'nginx\t%s\n' "$nginx_version" >> "$runtime_file"
else
  printf 'nginx\tunavailable\n' >> "$runtime_file"
fi

runtime_containers=()
split_paths "$NAV_RUNTIME_CONTAINERS" runtime_containers
printf 'container\tconfigured_image\timage_id\tstate\n' > "$STAGING_DIR/metadata/container-images.tsv"
for container_name in "${runtime_containers[@]}"; do
  [[ -z "$container_name" ]] && continue
  [[ "$container_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
    || fatal "$EX_CONFIG" "invalid runtime container name: $container_name"
  docker inspect "$container_name" >/dev/null 2>&1 \
    || fatal "$EX_SOFTWARE" "runtime container is unavailable: $container_name"
  docker inspect --format '{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.Image}}{{"\t"}}{{.State.Status}}' \
    "$container_name" | sed 's#^/##' >> "$STAGING_DIR/metadata/container-images.tsv"
done

CURRENT_STAGE="checksums and finalization"
tree_manifest="$STAGING_DIR/metadata/tree.tsv"
install -m 0600 /dev/null "$tree_manifest"

while IFS= read -r -d '' tree_entry; do
  relative_entry="${tree_entry#"$STAGING_DIR"/}"
  if [[ "$relative_entry" == *$'\t'* ||
        "$relative_entry" == *$'\r'* ||
        "$relative_entry" == *$'\n'* ||
        "$relative_entry" == *\\* ]]; then
    fatal "$EX_SOFTWARE" "backup tree contains an unsupported control character or backslash in a path"
  fi

  if [[ -L "$tree_entry" ]]; then
    if ! IFS= read -r -d '' link_target < <(readlink -z -- "$tree_entry"); then
      fatal "$EX_SOFTWARE" "could not read a symlink target in the backup tree"
    fi
    if [[ "$link_target" == *$'\t'* ||
          "$link_target" == *$'\r'* ||
          "$link_target" == *$'\n'* ||
          "$link_target" == *\\* ]]; then
      fatal "$EX_SOFTWARE" "backup tree contains an unsupported symlink target"
    fi
  elif [[ ! -f "$tree_entry" && ! -d "$tree_entry" ]]; then
    fatal "$EX_SOFTWARE" "backup tree contains an unsupported filesystem object: $relative_entry"
  fi
done < <(
  find -P "$STAGING_DIR" -mindepth 1 \
    ! -path "$STAGING_DIR/manifest.sha256" -print0
)

find -P "$STAGING_DIR" -mindepth 1 \
  ! -path "$STAGING_DIR/manifest.sha256" \
  -printf '%y\t%m\t%P\t%l\n' \
  | sort > "$tree_manifest"
[[ -s "$tree_manifest" ]] || fatal "$EX_SOFTWARE" "backup tree manifest is empty"

(
  cd "$STAGING_DIR"
  find -P . -type f ! -path './manifest.sha256' -print0 \
    | sort -z \
    | xargs -0 -r sha256sum > manifest.sha256
)
[[ -s "$STAGING_DIR/manifest.sha256" ]] \
  || fatal "$EX_SOFTWARE" "checksum manifest is empty"
chmod 0600 "$STAGING_DIR/manifest.sha256"

mv -- "$STAGING_DIR" "$FINAL_DIR"
STAGING_DIR=""
log "local backup completed: $FINAL_DIR"

load_restic_environment() {
  local path="$1"
  local line key value

  assert_safe_settings_file "$path" 600
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fatal "$EX_CONFIG" "invalid restic environment line"
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      RESTIC_REPOSITORY|RESTIC_PASSWORD_FILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_DEFAULT_REGION)
        export "$key=$value"
        ;;
      RESTIC_PASSWORD)
        fatal "$EX_CONFIG" "RESTIC_PASSWORD is forbidden; use RESTIC_PASSWORD_FILE"
        ;;
      *)
        fatal "$EX_CONFIG" "unsupported key in restic environment file: $key"
        ;;
    esac
  done < "$path"

  [[ "${RESTIC_REPOSITORY:-}" == s3:* ]] \
    || fatal "$EX_CONFIG" "RESTIC_REPOSITORY must use the s3 backend"
  [[ -n "${RESTIC_PASSWORD_FILE:-}" ]] \
    || fatal "$EX_CONFIG" "RESTIC_PASSWORD_FILE is required"
  assert_safe_settings_file "$RESTIC_PASSWORD_FILE" 600
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
    || fatal "$EX_CONFIG" "S3/R2 access credentials are missing"
}

if "$REQUEST_CLOUD_UPLOAD"; then
  CURRENT_STAGE="encrypted restic upload"
  command -v restic >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "restic is required"
  load_restic_environment "$NAV_RESTIC_ENV_FILE"

  CLOUD_WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nav-restic-evidence.XXXXXXXX")"
  chmod 0700 "$CLOUD_WORK_DIR"

  restic snapshots --json > "$CLOUD_WORK_DIR/repository-snapshots-before.json" \
    || fatal "$EX_SOFTWARE" "restic repository access check failed; initialize it separately"
  if ! restic backup "$FINAL_DIR" --tag "$NAV_RESTIC_TAG" --json \
    > "$CLOUD_WORK_DIR/backup.jsonl"; then
    fatal "$EX_SOFTWARE" "encrypted restic upload failed"
  fi
  jq -e . "$CLOUD_WORK_DIR/backup.jsonl" >/dev/null \
    || fatal "$EX_SOFTWARE" "restic backup returned invalid JSON evidence"

  mapfile -t restic_snapshot_ids < <(
    jq -r 'select(.message_type == "summary") | .snapshot_id // empty' \
      "$CLOUD_WORK_DIR/backup.jsonl"
  )
  (( ${#restic_snapshot_ids[@]} == 1 )) \
    || fatal "$EX_SOFTWARE" "restic backup did not return exactly one snapshot identifier"
  restic_snapshot_id="${restic_snapshot_ids[0]}"
  [[ "$restic_snapshot_id" =~ ^[0-9a-f]{64}$ ]] \
    || fatal "$EX_SOFTWARE" "restic backup returned an invalid snapshot identifier"

  restic snapshots "$restic_snapshot_id" --json \
    > "$CLOUD_WORK_DIR/exact-snapshot.json" \
    || fatal "$EX_SOFTWARE" "exact restic snapshot lookup failed"
  jq -e \
    --arg snapshot_id "$restic_snapshot_id" \
    --arg backup_path "$FINAL_DIR" \
    'type == "array"
     and length == 1
     and .[0].id == $snapshot_id
     and (.paths | type == "array")
     and (.paths | index($backup_path) != null)' \
    "$CLOUD_WORK_DIR/exact-snapshot.json" >/dev/null \
    || fatal "$EX_SOFTWARE" "restic snapshot metadata does not match this backup invocation"

  if ! restic dump "$restic_snapshot_id" "$FINAL_DIR/manifest.sha256" \
    > "$CLOUD_WORK_DIR/manifest-from-snapshot.sha256"; then
    fatal "$EX_SOFTWARE" "manifest.sha256 is missing from the exact restic snapshot"
  fi
  cmp -s \
    "$FINAL_DIR/manifest.sha256" \
    "$CLOUD_WORK_DIR/manifest-from-snapshot.sha256" \
    || fatal "$EX_SOFTWARE" "restic snapshot manifest does not match the local backup manifest"

  restic_check_status="skipped_by_config"
  if is_true "$NAV_RESTIC_RUN_CHECK"; then
    restic check \
      || fatal "$EX_SOFTWARE" "restic repository check failed"
    restic_check_status="passed"
  fi

  CURRENT_STAGE="restic evidence finalization"
  if [[ -e "$NAV_RESTIC_EVIDENCE_DIR" || -L "$NAV_RESTIC_EVIDENCE_DIR" ]]; then
    [[ -d "$NAV_RESTIC_EVIDENCE_DIR" && ! -L "$NAV_RESTIC_EVIDENCE_DIR" ]] \
      || fatal "$EX_CONFIG" "restic evidence path must be a non-symlink directory"
    [[ "$(stat -c '%u' -- "$NAV_RESTIC_EVIDENCE_DIR")" == "$EUID" ]] \
      || fatal "$EX_CONFIG" "restic evidence directory must be owned by uid $EUID"
  else
    install -d -m 0700 -- "$NAV_RESTIC_EVIDENCE_DIR"
  fi
  chmod 0700 "$NAV_RESTIC_EVIDENCE_DIR"
  restic_evidence_root="$(realpath -e -- "$NAV_RESTIC_EVIDENCE_DIR")"
  [[ "$restic_evidence_root" != "/" ]] \
    || fatal "$EX_CONFIG" "restic evidence directory must not be the filesystem root"
  [[ "$restic_evidence_root" != "$backup_root_real" &&
     "$restic_evidence_root" != "$backup_root_real"/* ]] \
    || fatal "$EX_CONFIG" "restic evidence directory must be outside NAV_BACKUP_ROOT"

  restic_evidence_name="${final_name}-${restic_snapshot_id:0:12}"
  restic_evidence_final="$restic_evidence_root/$restic_evidence_name"
  [[ ! -e "$restic_evidence_final" && ! -L "$restic_evidence_final" ]] \
    || fatal "$EX_CANTCREAT" "restic evidence destination already exists"
  RESTIC_EVIDENCE_STAGING="$(mktemp -d "$restic_evidence_root/.nav-restic-evidence.XXXXXXXX")"
  chmod 0700 "$RESTIC_EVIDENCE_STAGING"

  install -m 0600 "$CLOUD_WORK_DIR/backup.jsonl" \
    "$RESTIC_EVIDENCE_STAGING/backup.jsonl"
  install -m 0600 "$CLOUD_WORK_DIR/exact-snapshot.json" \
    "$RESTIC_EVIDENCE_STAGING/exact-snapshot.json"
  jq 'select(.message_type == "summary")' \
    "$CLOUD_WORK_DIR/backup.jsonl" \
    > "$RESTIC_EVIDENCE_STAGING/backup-summary.json"
  chmod 0600 "$RESTIC_EVIDENCE_STAGING/backup-summary.json"

  manifest_digest="$(sha256sum "$FINAL_DIR/manifest.sha256" | awk '{print $1}')"
  {
    printf 'key\tvalue\n'
    printf 'verified_utc\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    printf 'local_backup\t%s\n' "$FINAL_DIR"
    printf 'restic_snapshot_id\t%s\n' "$restic_snapshot_id"
    printf 'restic_tag\t%s\n' "$NAV_RESTIC_TAG"
    printf 'snapshot_path_match\tpassed\n'
    printf 'snapshot_manifest_match\tpassed\n'
    printf 'local_manifest_sha256\t%s\n' "$manifest_digest"
    printf 'restic_check\t%s\n' "$restic_check_status"
  } > "$RESTIC_EVIDENCE_STAGING/evidence.tsv"
  chmod 0600 "$RESTIC_EVIDENCE_STAGING/evidence.tsv"
  (
    cd "$RESTIC_EVIDENCE_STAGING"
    sha256sum backup.jsonl backup-summary.json exact-snapshot.json evidence.tsv \
      > evidence-files.sha256
  )
  chmod 0600 "$RESTIC_EVIDENCE_STAGING/evidence-files.sha256"
  mv -- "$RESTIC_EVIDENCE_STAGING" "$restic_evidence_final"
  RESTIC_EVIDENCE_STAGING=""
  cleanup_cloud_work

  log "encrypted restic snapshot verified: ${restic_snapshot_id:0:12}"
  log "restic evidence recorded: $restic_evidence_final"

  if "$REQUEST_CLOUD_FORGET"; then
    CURRENT_STAGE="explicit restic retention"
    restic forget \
      --tag "$NAV_RESTIC_TAG" \
      --keep-daily "$NAV_RESTIC_KEEP_DAILY" \
      --keep-weekly "$NAV_RESTIC_KEEP_WEEKLY" \
      --keep-monthly "$NAV_RESTIC_KEEP_MONTHLY" \
      --prune \
      || fatal "$EX_SOFTWARE" "restic retention failed"
    log "explicit restic retention completed"
  fi
fi

safe_delete_local_backup() {
  local candidate="$1"
  local candidate_real base
  candidate_real="$(realpath -e -- "$candidate")"
  base="$(basename "$candidate_real")"

  [[ "$candidate_real" == "$backup_root_real"/nav-* ]] \
    || fatal "$EX_SOFTWARE" "refused deletion outside backup root: $candidate"
  [[ "$base" =~ ^nav-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]] \
    || fatal "$EX_SOFTWARE" "refused deletion of unexpected directory: $candidate"
  [[ ! -L "$candidate" && -d "$candidate" ]] \
    || fatal "$EX_SOFTWARE" "refused deletion of symlink/non-directory: $candidate"

  rm -rf -- "$candidate_real"
}

if "$REQUEST_LOCAL_PRUNE"; then
  CURRENT_STAGE="explicit local retention"
  mapfile -t backup_candidates < <(
    find "$backup_root_real" -mindepth 1 -maxdepth 1 -type d \
      -name 'nav-*' -printf '%T@\t%p\n' | sort -nr
  )

  candidate_index=0
  for candidate_record in "${backup_candidates[@]}"; do
    candidate_index=$((candidate_index + 1))
    candidate_path="${candidate_record#*$'\t'}"
    (( candidate_index <= NAV_LOCAL_KEEP_COUNT )) && continue
    find "$candidate_path" -maxdepth 0 -mtime "+$NAV_LOCAL_KEEP_DAYS" -print -quit | grep -q . || continue
    safe_delete_local_backup "$candidate_path"
    log "pruned local backup: $candidate_path"
  done
fi

CURRENT_STAGE="complete"
log "backup workflow complete"
exit 0
