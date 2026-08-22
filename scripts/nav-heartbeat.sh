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
CONFIG_FILE="${NAV_HEARTBEAT_CONFIG:-/etc/nav/nav-heartbeat.env}"
JOB=""

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
Usage: nav-heartbeat.sh [--config FILE] <backup|restore>

The endpoint is read from a root-owned mode-600 file and is sent to curl over
stdin, never through argv. A heartbeat is a success signal; callers must invoke
this script only after the protected job has completed successfully.
EOF
}

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    backup|restore)
      [[ -z "$JOB" ]] || fatal "$EX_USAGE" "only one heartbeat job may be supplied"
      JOB="$1"
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

[[ "$JOB" == "backup" || "$JOB" == "restore" ]] \
  || fatal "$EX_USAGE" "heartbeat job must be backup or restore"
[[ "$CONFIG_FILE" == /* ]] || fatal "$EX_CONFIG" "config path must be absolute"
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] \
  || fatal "$EX_CONFIG" "config must be a regular non-symlink file"
[[ "$(stat -c '%u' -- "$CONFIG_FILE")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" "config must be owned by uid $EUID"
[[ "$(stat -c '%a' -- "$CONFIG_FILE")" == "600" ]] \
  || fatal "$EX_CONFIG" "config must have mode 600"

BACKUP_HEARTBEAT_URL=""
RESTORE_HEARTBEAT_URL=""
HEARTBEAT_TIMEOUT_SECONDS="10"

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || fatal "$EX_CONFIG" "invalid heartbeat config line"
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    NAV_BACKUP_HEARTBEAT_URL)
      [[ -z "$BACKUP_HEARTBEAT_URL" ]] || fatal "$EX_CONFIG" "duplicate backup heartbeat URL"
      BACKUP_HEARTBEAT_URL="$value"
      ;;
    NAV_RESTORE_HEARTBEAT_URL)
      [[ -z "$RESTORE_HEARTBEAT_URL" ]] || fatal "$EX_CONFIG" "duplicate restore heartbeat URL"
      RESTORE_HEARTBEAT_URL="$value"
      ;;
    NAV_HEARTBEAT_TIMEOUT_SECONDS)
      HEARTBEAT_TIMEOUT_SECONDS="$value"
      ;;
    *)
      fatal "$EX_CONFIG" "unsupported heartbeat config key: $key"
      ;;
  esac
done < "$CONFIG_FILE"

[[ "$HEARTBEAT_TIMEOUT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] \
  || fatal "$EX_CONFIG" "heartbeat timeout must be an integer from 1 to 999"

if [[ "$JOB" == "backup" ]]; then
  HEARTBEAT_URL="$BACKUP_HEARTBEAT_URL"
else
  HEARTBEAT_URL="$RESTORE_HEARTBEAT_URL"
fi

[[ -n "$HEARTBEAT_URL" ]] || fatal "$EX_CONFIG" "$JOB heartbeat URL is missing"
[[ "$HEARTBEAT_URL" == https://* ]] \
  || fatal "$EX_CONFIG" "heartbeat URL must use HTTPS"
case "$HEARTBEAT_URL" in
  *$'\n'*|*$'\r'*|*$'\t'*|*' '*|*'"'*|*\\*)
    fatal "$EX_CONFIG" "heartbeat URL contains an unsafe character"
    ;;
esac

authority="${HEARTBEAT_URL#https://}"
authority="${authority%%/*}"
[[ "$authority" =~ ^[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
  || fatal "$EX_CONFIG" "heartbeat URL authority is invalid"

command -v curl >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "curl is required"

# The bearer-like heartbeat URL is supplied over stdin so it is not visible in
# /proc/<pid>/cmdline, systemd status output, or scheduler process listings.
if ! curl -q --config - \
  --fail --silent --show-error \
  --max-time "$HEARTBEAT_TIMEOUT_SECONDS" \
  --request POST \
  --data '' \
  >/dev/null <<EOF
url = "$HEARTBEAT_URL"
EOF
then
  fatal "$EX_SOFTWARE" "$JOB success heartbeat delivery failed"
fi

HEARTBEAT_URL=""
BACKUP_HEARTBEAT_URL=""
RESTORE_HEARTBEAT_URL=""
log "$JOB success heartbeat delivered"
