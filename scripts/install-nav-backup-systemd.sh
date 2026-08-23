#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_UNAVAILABLE=69
readonly EX_CONFIG=78

PROGRAM_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SYSTEMD_SOURCE="$SOURCE_ROOT/ops/systemd"

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

fatal() {
  local code="$1"
  shift
  log "ERROR: $*"
  exit "$code"
}

(( EUID == 0 )) || fatal "$EX_CONFIG" "run this installer as root"
for command_name in install systemctl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

declare -a scripts=(
  nav-backup.sh
  nav-restore-rehearsal.sh
  nav-restore-latest.sh
  nav-restore-cloud-latest.sh
  nav-heartbeat.sh
  nav-job-failure-notify.sh
)
declare -a units=(
  nav-backup.service
  nav-backup.timer
  nav-backup-retention.service
  nav-backup-retention.timer
  nav-restore-rehearsal.service
  nav-restore-rehearsal.timer
  nav-scheduled-failure@.service
)

for name in "${scripts[@]}"; do
  [[ -f "$SCRIPT_DIR/$name" && ! -L "$SCRIPT_DIR/$name" ]] \
    || fatal "$EX_CONFIG" "missing source script: $name"
done
for name in "${units[@]}"; do
  [[ -f "$SYSTEMD_SOURCE/$name" && ! -L "$SYSTEMD_SOURCE/$name" ]] \
    || fatal "$EX_CONFIG" "missing systemd source: $name"
done

install -d -o root -g root -m 0700 /etc/nav
install -d -o root -g root -m 0700 \
  /var/backups/nav \
  /var/backups/nav-cloud-restore \
  /var/backups/nav-restic-evidence \
  /var/backups/nav-rehearsal-reports
install -d -o root -g root -m 0755 /usr/share/doc/domo-nav

for name in "${scripts[@]}"; do
  target_name="${name%.sh}"
  install -o root -g root -m 0750 "$SCRIPT_DIR/$name" "/usr/local/sbin/$target_name"
done
for name in "${units[@]}"; do
  install -o root -g root -m 0644 "$SYSTEMD_SOURCE/$name" "/etc/systemd/system/$name"
done
install -o root -g root -m 0644 \
  "$SOURCE_ROOT/docs/NAV_BACKUP_RUNBOOK.md" \
  /usr/share/doc/domo-nav/NAV_BACKUP_RUNBOOK.md

if command -v systemd-analyze >/dev/null 2>&1; then
  unit_paths=()
  for name in "${units[@]}"; do
    unit_paths+=("/etc/systemd/system/$name")
  done
  systemd-analyze verify "${unit_paths[@]}"
fi
systemctl daemon-reload

log "backup scripts and units installed without enabling or starting any timer"
log "create and validate the mode-600 config/credential files, run manual backup and restore gates, then enable timers in a separately authorized production step"
