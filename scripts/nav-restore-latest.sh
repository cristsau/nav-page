#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_CONFIG=78

PROGRAM_NAME="$(basename "$0")"
CONFIG_FILE="${NAV_BACKUP_CONFIG:-/etc/nav/nav-backup.env}"

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

fatal() {
  local code="$1"
  shift
  log "ERROR: $*"
  exit "$code"
}

usage() {
  printf 'Usage: nav-restore-latest.sh [--config FILE]\n'
}

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
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

[[ "$CONFIG_FILE" == /* ]] || fatal "$EX_CONFIG" "config path must be absolute"
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] \
  || fatal "$EX_CONFIG" "config must be a regular non-symlink file"
mode="$(stat -c '%a' -- "$CONFIG_FILE")"
owner="$(stat -c '%u' -- "$CONFIG_FILE")"
[[ "$owner" == "$EUID" ]] || fatal "$EX_CONFIG" "config must be owned by uid $EUID"
(( (8#$mode & 022) == 0 )) || fatal "$EX_CONFIG" "config must not be group/world writable"

# shellcheck source=/dev/null
source "$CONFIG_FILE"
: "${NAV_BACKUP_ROOT:=/var/backups/nav}"
: "${NAV_RESTORE_SCRIPT:=/usr/local/sbin/nav-restore-rehearsal}"
: "${NAV_REHEARSAL_MAX_BACKUP_AGE_HOURS:=48}"

[[ "$NAV_BACKUP_ROOT" == /* ]] || fatal "$EX_CONFIG" "NAV_BACKUP_ROOT must be absolute"
[[ "$NAV_RESTORE_SCRIPT" == /* ]] || fatal "$EX_CONFIG" "NAV_RESTORE_SCRIPT must be absolute"
[[ "$NAV_REHEARSAL_MAX_BACKUP_AGE_HOURS" =~ ^[1-9][0-9]{0,4}$ ]] \
  || fatal "$EX_CONFIG" "NAV_REHEARSAL_MAX_BACKUP_AGE_HOURS must be from 1 to 99999"
[[ -d "$NAV_BACKUP_ROOT" && ! -L "$NAV_BACKUP_ROOT" ]] \
  || fatal "$EX_CONFIG" "backup root must be a non-symlink directory"
[[ -f "$NAV_RESTORE_SCRIPT" && ! -L "$NAV_RESTORE_SCRIPT" && -x "$NAV_RESTORE_SCRIPT" ]] \
  || fatal "$EX_CONFIG" "restore script must be an executable regular non-symlink file"
[[ "$(stat -c '%u' -- "$NAV_RESTORE_SCRIPT")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" "restore script must be owned by uid $EUID"
restore_mode="$(stat -c '%a' -- "$NAV_RESTORE_SCRIPT")"
(( (8#$restore_mode & 022) == 0 )) \
  || fatal "$EX_CONFIG" "restore script must not be group/world writable"

for command_name in find sort realpath stat; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

backup_root_real="$(realpath -e -- "$NAV_BACKUP_ROOT")"
mapfile -d '' -t candidate_records < <(
  find -P "$backup_root_real" -mindepth 1 -maxdepth 1 -type d \
    -name 'nav-*' -printf '%T@\t%p\0' | sort -z -nr
)

latest_backup=""
for record in "${candidate_records[@]}"; do
  candidate="${record#*$'\t'}"
  base="$(basename "$candidate")"
  [[ "$base" =~ ^nav-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]] || continue
  [[ -d "$candidate" && ! -L "$candidate" ]] || continue
  candidate_real="$(realpath -e -- "$candidate")"
  [[ "$candidate_real" == "$backup_root_real"/nav-* ]] || continue
  latest_backup="$candidate_real"
  break
done

[[ -n "$latest_backup" ]] || fatal "$EX_SOFTWARE" "no valid local NAV backup is available"

now_epoch="$(date +%s)"
backup_epoch="$(stat -c '%Y' -- "$latest_backup")"
age_seconds=$((now_epoch - backup_epoch))
(( age_seconds >= -300 )) || fatal "$EX_SOFTWARE" "latest backup timestamp is unexpectedly in the future"
(( age_seconds < 0 )) && age_seconds=0
max_age_seconds=$((NAV_REHEARSAL_MAX_BACKUP_AGE_HOURS * 3600))
(( age_seconds <= max_age_seconds )) \
  || fatal "$EX_SOFTWARE" "latest backup is older than the configured rehearsal maximum age"

log "starting isolated rehearsal for the newest eligible local backup"
exec "$NAV_RESTORE_SCRIPT" \
  --config "$CONFIG_FILE" \
  --backup "$latest_backup" \
  --run-isolated
