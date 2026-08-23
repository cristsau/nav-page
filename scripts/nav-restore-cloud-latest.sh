#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_CANTCREAT=73
readonly EX_CONFIG=78
readonly EX_VERIFY=80

PROGRAM_NAME="$(basename "$0")"
CONFIG_FILE="${NAV_BACKUP_CONFIG:-/etc/nav/nav-backup.env}"
REQUEST_CLOUD_RESTORE=false
CURRENT_STAGE="initialization"
CLOUD_RESTORE_ROOT_REAL=""
WORK_DIR=""

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  nav-restore-cloud-latest.sh --cloud-restore [--config FILE]

Safety gates:
  --cloud-restore is mandatory and the mode-600 config must set
  NAV_ENABLE_CLOUD_RESTORE_REHEARSAL=true.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup_secrets() {
  unset RESTIC_REPOSITORY RESTIC_PASSWORD_FILE RESTIC_PASSWORD
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_DEFAULT_REGION
}

cleanup_work_dir() {
  local work_real owner mode

  [[ -n "$WORK_DIR" && -e "$WORK_DIR" ]] || {
    WORK_DIR=""
    return 0
  }
  [[ -n "$CLOUD_RESTORE_ROOT_REAL" ]] || {
    log "refused to remove cloud-restore work directory before its root was verified"
    return 1
  }
  [[ -d "$WORK_DIR" && ! -L "$WORK_DIR" ]] || {
    log "refused to remove a non-directory or symlink cloud-restore work path"
    return 1
  }

  work_real="$(realpath -e -- "$WORK_DIR" 2>/dev/null || true)"
  owner="$(stat -c '%u' -- "$WORK_DIR" 2>/dev/null || true)"
  mode="$(stat -c '%a' -- "$WORK_DIR" 2>/dev/null || true)"
  if [[ -n "$work_real" &&
        "$work_real" == "$CLOUD_RESTORE_ROOT_REAL"/.nav-cloud-restore.* &&
        "$(dirname "$work_real")" == "$CLOUD_RESTORE_ROOT_REAL" &&
        "$owner" == "$EUID" &&
        "$mode" == "700" ]]; then
    rm -rf -- "$work_real"
    WORK_DIR=""
    return 0
  fi

  log "refused to remove an unverified cloud-restore work path"
  return 1
}

fatal() {
  local exit_code="$1"
  shift
  local message="$*"

  trap - ERR
  log "ERROR [$CURRENT_STAGE]: $message"
  cleanup_work_dir || true
  cleanup_secrets
  exit "$exit_code"
}

handle_error() {
  local original_code="$1"
  local line="$2"
  local mapped_code="$original_code"

  if ((mapped_code < 64 || mapped_code > 125)); then
    mapped_code="$EX_SOFTWARE"
  fi
  fatal "$mapped_code" "unexpected command failure at line $line (original exit $original_code)"
}

trap 'handle_error "$?" "$LINENO"' ERR
trap 'cleanup_work_dir || true; cleanup_secrets' EXIT
trap 'fatal 130 "interrupted by signal"' INT TERM

assert_safe_file() {
  local path="$1"
  local description="$2"
  local owner mode

  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "$description path must be absolute"
  [[ -f "$path" && ! -L "$path" ]] \
    || fatal "$EX_CONFIG" "$description must be a regular non-symlink file"
  owner="$(stat -c '%u' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [[ "$owner" == "$EUID" ]] \
    || fatal "$EX_CONFIG" "$description must be owned by uid $EUID"
  [[ "$mode" == "600" ]] \
    || fatal "$EX_CONFIG" "$description must have mode 600"
}

ensure_safe_directory() {
  local path="$1"
  local description="$2"
  local resolved owner mode

  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "$description path must be absolute"
  [[ "$path" != "/" ]] || fatal "$EX_CONFIG" "$description must not be the filesystem root"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] \
      || fatal "$EX_CONFIG" "$description must be a non-symlink directory"
  else
    install -d -m 0700 -- "$path" \
      || fatal "$EX_CANTCREAT" "could not create $description"
  fi
  resolved="$(realpath -e -- "$path")"
  owner="$(stat -c '%u' -- "$resolved")"
  mode="$(stat -c '%a' -- "$resolved")"
  [[ "$owner" == "$EUID" ]] \
    || fatal "$EX_CONFIG" "$description must be owned by uid $EUID"
  [[ "$mode" == "700" ]] \
    || fatal "$EX_CONFIG" "$description must have mode 700"
  printf '%s\n' "$resolved"
}

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --cloud-restore)
      "$REQUEST_CLOUD_RESTORE" \
        && fatal "$EX_USAGE" "--cloud-restore may be supplied only once"
      REQUEST_CLOUD_RESTORE=true
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

"$REQUEST_CLOUD_RESTORE" || {
  usage >&2
  exit "$EX_USAGE"
}

if ((EUID != 0)); then
  if [[ "${CI:-}" != "true" ||
        "${NODE_ENV:-}" != "test" ||
        "${NAV_CLOUD_RESTORE_REHEARSAL_TEST:-}" != "true" ]]; then
    fatal "$EX_CONFIG" "cloud restore rehearsal must run as root outside the explicit CI test gate"
  fi
fi

for command_name in stat realpath install chmod mktemp rm dirname basename python3 jq restic; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

assert_safe_file "$CONFIG_FILE" "backup configuration"
unset NAV_ENABLE_CLOUD_RESTORE_REHEARSAL
# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${NAV_ENABLE_CLOUD_RESTORE_REHEARSAL:=false}"
: "${NAV_RESTIC_ENV_FILE:=/etc/nav/restic-r2.env}"
: "${NAV_RESTIC_TAG:=domo-nav}"
: "${NAV_RESTIC_CACHE_DIR:=/var/cache/nav-restic}"
: "${NAV_CLOUD_RESTORE_ROOT:=/var/backups/nav-cloud-restore}"
: "${NAV_CLOUD_REHEARSAL_MAX_SNAPSHOT_AGE_HOURS:=48}"
: "${NAV_RESTORE_SCRIPT:=/usr/local/sbin/nav-restore-rehearsal}"

is_true "$NAV_ENABLE_CLOUD_RESTORE_REHEARSAL" \
  || fatal "$EX_CONFIG" "--cloud-restore requires NAV_ENABLE_CLOUD_RESTORE_REHEARSAL=true"
[[ "$NAV_RESTIC_TAG" =~ ^[A-Za-z0-9_.-]+$ ]] \
  || fatal "$EX_CONFIG" "invalid NAV_RESTIC_TAG"
[[ "$NAV_CLOUD_REHEARSAL_MAX_SNAPSHOT_AGE_HOURS" =~ ^[1-9][0-9]{0,4}$ ]] \
  || fatal "$EX_CONFIG" "NAV_CLOUD_REHEARSAL_MAX_SNAPSHOT_AGE_HOURS must be from 1 to 99999"
[[ "$NAV_RESTORE_SCRIPT" == /* ]] \
  || fatal "$EX_CONFIG" "NAV_RESTORE_SCRIPT must be absolute"
[[ -f "$NAV_RESTORE_SCRIPT" && ! -L "$NAV_RESTORE_SCRIPT" && -x "$NAV_RESTORE_SCRIPT" ]] \
  || fatal "$EX_CONFIG" "NAV_RESTORE_SCRIPT must be an executable regular non-symlink file"
[[ "$(stat -c '%u' -- "$NAV_RESTORE_SCRIPT")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" "NAV_RESTORE_SCRIPT must be owned by uid $EUID"
restore_script_mode="$(stat -c '%a' -- "$NAV_RESTORE_SCRIPT")"
(( (8#$restore_script_mode & 022) == 0 )) \
  || fatal "$EX_CONFIG" "NAV_RESTORE_SCRIPT must not be group/world writable"

CLOUD_RESTORE_ROOT_REAL="$(ensure_safe_directory "$NAV_CLOUD_RESTORE_ROOT" "cloud restore root")"
RESTIC_CACHE_DIR="$(ensure_safe_directory "$NAV_RESTIC_CACHE_DIR" "restic cache directory")"
export RESTIC_CACHE_DIR

assert_safe_file "$NAV_RESTIC_ENV_FILE" "restic environment"
cleanup_secrets
export RESTIC_CACHE_DIR

declare -A restic_keys_seen=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || fatal "$EX_CONFIG" "invalid restic environment line"
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    RESTIC_REPOSITORY|RESTIC_PASSWORD_FILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_DEFAULT_REGION)
      ;;
    RESTIC_PASSWORD)
      fatal "$EX_CONFIG" "RESTIC_PASSWORD is forbidden; use RESTIC_PASSWORD_FILE"
      ;;
    *)
      fatal "$EX_CONFIG" "unsupported key in restic environment file: $key"
      ;;
  esac
  [[ -z "${restic_keys_seen[$key]+present}" ]] \
    || fatal "$EX_CONFIG" "duplicate key in restic environment: $key"
  restic_keys_seen["$key"]=true
  export "$key=$value"
done < "$NAV_RESTIC_ENV_FILE"

[[ "${RESTIC_REPOSITORY:-}" == s3:* ]] \
  || fatal "$EX_CONFIG" "RESTIC_REPOSITORY must use the s3 backend"
[[ -n "${RESTIC_PASSWORD_FILE:-}" ]] \
  || fatal "$EX_CONFIG" "RESTIC_PASSWORD_FILE is required"
assert_safe_file "$RESTIC_PASSWORD_FILE" "restic password file"
[[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
  || fatal "$EX_CONFIG" "S3/R2 access credentials are missing"

CURRENT_STAGE="cloud restore workspace creation"
WORK_DIR="$(mktemp -d "$CLOUD_RESTORE_ROOT_REAL/.nav-cloud-restore.XXXXXXXX")"
chmod 0700 "$WORK_DIR"
[[ "$(stat -c '%u' -- "$WORK_DIR")" == "$EUID" && "$(stat -c '%a' -- "$WORK_DIR")" == "700" ]] \
  || fatal "$EX_CANTCREAT" "cloud restore workspace ownership or mode is unsafe"
work_real="$(realpath -e -- "$WORK_DIR")"
[[ "$work_real" == "$CLOUD_RESTORE_ROOT_REAL"/.nav-cloud-restore.* &&
   "$(dirname "$work_real")" == "$CLOUD_RESTORE_ROOT_REAL" ]] \
  || fatal "$EX_CANTCREAT" "cloud restore workspace escaped its configured root"

snapshot_json="$WORK_DIR/snapshot.json"
CURRENT_STAGE="exact tagged cloud snapshot selection"
restic snapshots --tag "$NAV_RESTIC_TAG" --latest 1 --json > "$snapshot_json" \
  || fatal "$EX_SOFTWARE" "could not list the latest tagged restic snapshot"

jq -e --arg tag "$NAV_RESTIC_TAG" '
  type == "array"
  and length == 1
  and (.[] | type == "object")
  and (.[0].id | type == "string" and test("^[0-9a-f]{64}$"))
  and (.[0].tags | type == "array" and index($tag) != null)
  and (.[0].paths | type == "array" and length == 1)
  and (.[0].paths[0] | type == "string" and startswith("/"))
  and (.[0].time | type == "string")
' "$snapshot_json" >/dev/null \
  || fatal "$EX_VERIFY" "latest tagged restic snapshot metadata is malformed or ambiguous"

snapshot_id="$(jq -r '.[0].id' "$snapshot_json")"
snapshot_path="$(jq -r '.[0].paths[0]' "$snapshot_json")"
snapshot_time="$(jq -r '.[0].time' "$snapshot_json")"

python3 - "$snapshot_path" <<'PY' \
  || fatal "$EX_VERIFY" "restic snapshot path is not one normalized absolute nav-* directory"
import posixpath
import re
import sys

path = sys.argv[1]
if not path.startswith('/') or posixpath.normpath(path) != path:
    raise SystemExit(1)
if any(character in path for character in ('\n', '\r', '\t', '\\')):
    raise SystemExit(1)
if not re.fullmatch(r'nav-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+', posixpath.basename(path)):
    raise SystemExit(1)
PY

python3 - "$snapshot_time" "$NAV_CLOUD_REHEARSAL_MAX_SNAPSHOT_AGE_HOURS" <<'PY' \
  || fatal "$EX_VERIFY" "latest tagged restic snapshot is stale or has an invalid timestamp"
from datetime import datetime, timezone
import sys

raw = sys.argv[1]
maximum_hours = int(sys.argv[2])
try:
    parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
except ValueError:
    raise SystemExit(1)
if parsed.tzinfo is None:
    raise SystemExit(1)
age_seconds = (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds()
if age_seconds < -300 or age_seconds > maximum_hours * 3600:
    raise SystemExit(1)
PY

restore_target="$WORK_DIR/restore"
install -d -m 0700 -- "$restore_target"
CURRENT_STAGE="exact cloud snapshot restore"
restic restore "$snapshot_id" \
  --target "$restore_target" \
  --include "$snapshot_path" \
  || fatal "$EX_VERIFY" "exact restic snapshot restore failed"

restore_target_real="$(realpath -e -- "$restore_target")"
restored_candidate="$restore_target/${snapshot_path#/}"
[[ -d "$restored_candidate" && ! -L "$restored_candidate" ]] \
  || fatal "$EX_VERIFY" "restic did not restore the exact selected backup directory"
restored_real="$(realpath -e -- "$restored_candidate")"
[[ "$restored_real" == "$restore_target_real"/* ]] \
  || fatal "$EX_VERIFY" "restored backup directory escaped the verified restore target"
[[ "$(basename "$restored_real")" == "$(basename "$snapshot_path")" ]] \
  || fatal "$EX_VERIFY" "restored backup directory identity does not match snapshot metadata"

python3 - "$restore_target_real" "$restored_real" <<'PY' \
  || fatal "$EX_VERIFY" "restic restored content outside the exact selected snapshot path"
import os
import sys

target = os.path.realpath(sys.argv[1])
expected = os.path.realpath(sys.argv[2])
for current, directories, files in os.walk(target, topdown=True, followlinks=False):
    for name in directories + files:
        candidate = os.path.join(current, name)
        allowed = (
            candidate == expected
            or expected.startswith(candidate + os.sep)
            or candidate.startswith(expected + os.sep)
        )
        if not allowed:
            raise SystemExit(1)
PY

restored_parent="$(dirname "$restored_real")"
CURRENT_STAGE="isolated verification of cloud-restored backup"
"$NAV_RESTORE_SCRIPT" \
  --config "$CONFIG_FILE" \
  --backup-root "$restored_parent" \
  --backup "$restored_real" \
  --run-isolated \
  || fatal "$EX_VERIFY" "isolated verification of the cloud-restored backup failed"

CURRENT_STAGE="verified cloud restore cleanup"
cleanup_work_dir \
  || fatal "$EX_SOFTWARE" "verified cloud restore workspace cleanup failed"
cleanup_secrets
CURRENT_STAGE="complete"
log "cloud restore rehearsal passed for exact snapshot ${snapshot_id:0:12}"
exit 0
