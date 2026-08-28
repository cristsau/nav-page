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
LOG_RETENTION_SOURCE="$SOURCE_ROOT/ops/cron/nav-log-retention"

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
for command_name in install systemctl python3; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

declare -a scripts=(
  nav-backup.sh
  nav-restore-rehearsal.sh
  nav-restore-latest.sh
  nav-restore-cloud-latest.sh
  nav-disaster-restore.sh
  nav-heartbeat.sh
  nav-job-failure-notify.sh
  nav-release-link.sh
  enable-nav-local-backup-timers.sh
  nav-controlled-cleanup.sh
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
[[ -f "$LOG_RETENTION_SOURCE" && ! -L "$LOG_RETENTION_SOURCE" ]] \
  || fatal "$EX_CONFIG" "missing source script: ops/cron/nav-log-retention"

install -d -o root -g root -m 0700 /etc/nav
install -d -o root -g root -m 0700 /etc/nav/integrations
install -d -o root -g root -m 0700 \
  /var/backups/nav \
  /var/backups/nav-cloud-restore \
  /var/backups/nav-restic-evidence \
  /var/backups/nav-rehearsal-reports \
  /var/backups/nav-disaster-rollback
install -d -o root -g root -m 0755 /usr/share/doc/domo-nav

for name in "${scripts[@]}"; do
  target_name="${name%.sh}"
  install -o root -g root -m 0750 "$SCRIPT_DIR/$name" "/usr/local/sbin/$target_name"
done
for name in "${units[@]}"; do
  install -o root -g root -m 0644 "$SYSTEMD_SOURCE/$name" "/etc/systemd/system/$name"
done
install -o root -g root -m 0755 "$LOG_RETENTION_SOURCE" /etc/cron.daily/nav-log-retention
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

python3 - <<'PY'
import json
from datetime import datetime, timezone
from pathlib import Path

target = Path('/etc/nav/integrations/cloud-backup-agent.json')
payload = {
    'installed': True,
    'timerEnabled': False,
    'updatedAt': datetime.now(timezone.utc).isoformat(),
}
temporary = target.with_name(f'.{target.name}.tmp')
temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
temporary.chmod(0o600)
temporary.replace(target)
target.chmod(0o600)
PY

log "backup scripts and units installed without enabling or starting any timer"
log "copy and validate the mode-600 local backup config, then run enable-nav-local-backup-timers --check"
log "only enable-nav-local-backup-timers --enable may enable the local timers after backup and isolated-restore proof; no offsite timer is installed"
