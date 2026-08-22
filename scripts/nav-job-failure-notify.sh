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
CONFIG_FILE="${NAV_SCHEDULED_FAILURE_CONFIG:-/etc/nav/backup-telegram.env}"
UNIT_NAME=""

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
  printf 'Usage: nav-job-failure-notify.sh [--config FILE] <systemd-unit>\n'
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
      [[ -z "$UNIT_NAME" ]] || fatal "$EX_USAGE" "only one unit name may be supplied"
      UNIT_NAME="$1"
      shift
      ;;
  esac
done

[[ "$UNIT_NAME" =~ ^[A-Za-z0-9_.@:-]{1,128}$ ]] \
  || fatal "$EX_USAGE" "invalid systemd unit name"
[[ "$CONFIG_FILE" == /* ]] || fatal "$EX_CONFIG" "config path must be absolute"
[[ -f "$CONFIG_FILE" && ! -L "$CONFIG_FILE" ]] \
  || fatal "$EX_CONFIG" "config must be a regular non-symlink file"
[[ "$(stat -c '%u' -- "$CONFIG_FILE")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" "config must be owned by uid $EUID"
[[ "$(stat -c '%a' -- "$CONFIG_FILE")" == "600" ]] \
  || fatal "$EX_CONFIG" "config must have mode 600"

TELEGRAM_BOT_TOKEN_VALUE=""
TELEGRAM_CHAT_ID_VALUE=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || fatal "$EX_CONFIG" "invalid Telegram config line"
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    TELEGRAM_BOT_TOKEN)
      [[ -z "$TELEGRAM_BOT_TOKEN_VALUE" ]] || fatal "$EX_CONFIG" "duplicate bot token"
      TELEGRAM_BOT_TOKEN_VALUE="$value"
      ;;
    TELEGRAM_CHAT_ID)
      [[ -z "$TELEGRAM_CHAT_ID_VALUE" ]] || fatal "$EX_CONFIG" "duplicate chat id"
      TELEGRAM_CHAT_ID_VALUE="$value"
      ;;
    *)
      fatal "$EX_CONFIG" "unsupported Telegram config key: $key"
      ;;
  esac
done < "$CONFIG_FILE"

[[ "$TELEGRAM_BOT_TOKEN_VALUE" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] \
  || fatal "$EX_CONFIG" "invalid Telegram bot token"
[[ "$TELEGRAM_CHAT_ID_VALUE" =~ ^-?[0-9]+$ ]] \
  || fatal "$EX_CONFIG" "invalid Telegram chat id"
command -v curl >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "curl is required"

alert_text="DOMO NAV scheduled job failed
host: $(hostname -f 2>/dev/null || hostname)
unit: $UNIT_NAME
time: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
action: inspect the unit journal and do not send a success heartbeat"

if ! curl -q --config - \
  --fail --silent --show-error \
  --max-time 10 \
  --data-urlencode "chat_id=$TELEGRAM_CHAT_ID_VALUE" \
  --data-urlencode "text=$alert_text" \
  >/dev/null <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_VALUE}/sendMessage"
EOF
then
  fatal "$EX_SOFTWARE" "Telegram failure notification could not be delivered"
fi

TELEGRAM_BOT_TOKEN_VALUE=""
TELEGRAM_CHAT_ID_VALUE=""
log "failure notification delivered for $UNIT_NAME"
