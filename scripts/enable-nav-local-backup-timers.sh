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
ENABLE=false

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
  cat <<'EOF'
Usage: enable-nav-local-backup-timers.sh [--config FILE] [--check|--enable]

--check is read-only and is the default. --enable first creates a new local
backup, proves a network-less PostgreSQL restore of that backup, and only then
enables the three local timers. It never enables or claims offsite storage.
EOF
}

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --check)
      ENABLE=false
      shift
      ;;
    --enable)
      ENABLE=true
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

(( EUID == 0 )) || fatal "$EX_CONFIG" "run this gate as root"
for command_name in stat realpath systemctl docker grep; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done
[[ "$CONFIG_FILE" == /* && -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] \
  || fatal "$EX_CONFIG" "backup config must be an absolute regular non-symlink file"
[[ "$(stat -c '%u' -- "$CONFIG_FILE")" == 0 && "$(stat -c '%a' -- "$CONFIG_FILE")" == 600 ]] \
  || fatal "$EX_CONFIG" "backup config must be root-owned mode 600"

# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${NAV_PROJECT_DIR:=}"
: "${NAV_FRONTEND_DIR:=}"
: "${NAV_ENABLE_LOCAL_PRUNE:=false}"
: "${NAV_LOCAL_KEEP_DAYS:=0}"
: "${NAV_LOCAL_KEEP_COUNT:=0}"
: "${NAV_ENABLE_RESTORE_CONTAINER:=false}"
: "${NAV_RESTORE_POSTGRES_IMAGE:=postgres:16-alpine}"
: "${NAV_ENABLE_CLOUD_UPLOAD:=false}"
: "${NAV_ENABLE_CLOUD_RESTORE_REHEARSAL:=false}"
: "${NAV_ENABLE_RESTIC_FORGET:=false}"

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

for cloud_gate in \
  NAV_ENABLE_CLOUD_UPLOAD \
  NAV_ENABLE_CLOUD_RESTORE_REHEARSAL \
  NAV_ENABLE_RESTIC_FORGET; do
  ! is_true "${!cloud_gate}" \
    || fatal "$EX_CONFIG" "$cloud_gate must remain false for the local-only timer profile"
done
is_true "$NAV_ENABLE_LOCAL_PRUNE" \
  || fatal "$EX_CONFIG" "NAV_ENABLE_LOCAL_PRUNE=true is required"
is_true "$NAV_ENABLE_RESTORE_CONTAINER" \
  || fatal "$EX_CONFIG" "NAV_ENABLE_RESTORE_CONTAINER=true is required"
[[ "$NAV_LOCAL_KEEP_DAYS" =~ ^[0-9]+$ && "$NAV_LOCAL_KEEP_DAYS" -ge 7 ]] \
  || fatal "$EX_CONFIG" "NAV_LOCAL_KEEP_DAYS must be at least 7"
[[ "$NAV_LOCAL_KEEP_COUNT" =~ ^[0-9]+$ && "$NAV_LOCAL_KEEP_COUNT" -ge 2 ]] \
  || fatal "$EX_CONFIG" "NAV_LOCAL_KEEP_COUNT must be at least 2"

[[ "$NAV_PROJECT_DIR" == /opt/nav-stack/current ]] \
  || fatal "$EX_CONFIG" "NAV_PROJECT_DIR must use /opt/nav-stack/current"
[[ "$NAV_FRONTEND_DIR" == /opt/nav-stack/current/frontend-dist ]] \
  || fatal "$EX_CONFIG" "NAV_FRONTEND_DIR must use the current release link"
/usr/local/sbin/nav-release-link status >/dev/null \
  || fatal "$EX_CONFIG" "current release link is missing or invalid"
docker image inspect "$NAV_RESTORE_POSTGRES_IMAGE" >/dev/null 2>&1 \
  || fatal "$EX_CONFIG" "the pinned restore image is not present locally; automatic pull is forbidden"

for unit in \
  nav-backup.service nav-backup.timer \
  nav-backup-retention.service nav-backup-retention.timer \
  nav-restore-rehearsal.service nav-restore-rehearsal.timer; do
  systemctl cat "$unit" >/dev/null 2>&1 \
    || fatal "$EX_CONFIG" "required unit is not installed: $unit"
done
systemctl cat nav-backup.service | grep -F -- '/usr/local/sbin/nav-backup --config /etc/nav/nav-backup.env' >/dev/null \
  || fatal "$EX_CONFIG" "backup unit is not the reviewed local-only unit"
if systemctl cat nav-backup.service | grep -F -- '--cloud-upload' >/dev/null; then
  fatal "$EX_CONFIG" "backup unit unexpectedly requests offsite upload"
fi
systemctl cat nav-restore-rehearsal.service | grep -F -- '/usr/local/sbin/nav-restore-latest' >/dev/null \
  || fatal "$EX_CONFIG" "restore unit is not the reviewed local selector"

/usr/local/sbin/nav-backup --config "$CONFIG_FILE" --dry-run >/dev/null \
  || fatal "$EX_CONFIG" "local backup preflight failed"
log "local-only timer preflight passed; offsite gates remain disabled"

if ! "$ENABLE"; then
  log "check complete; no service or timer was started or enabled"
  exit 0
fi

systemctl start nav-backup.service \
  || fatal "$EX_SOFTWARE" "manual local backup service failed"
systemctl start nav-restore-rehearsal.service \
  || fatal "$EX_SOFTWARE" "manual isolated restore service failed"
systemctl enable --now \
  nav-backup.timer \
  nav-backup-retention.timer \
  nav-restore-rehearsal.timer \
  || fatal "$EX_SOFTWARE" "could not enable local timers"

for timer in nav-backup.timer nav-backup-retention.timer nav-restore-rehearsal.timer; do
  [[ "$(systemctl is-enabled "$timer")" == enabled ]] \
    || fatal "$EX_SOFTWARE" "$timer is not enabled after the transaction"
  [[ "$(systemctl is-active "$timer")" == active ]] \
    || fatal "$EX_SOFTWARE" "$timer is not active after the transaction"
done
log "local backup, local retention and local isolated-restore timers enabled"
