#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_USAGE=64
readonly EX_SOFTWARE=70
readonly EX_CANTCREAT=73
readonly EX_TEMPFAIL=75
readonly EX_CONFIG=78
readonly DEFAULT_RELEASES_ROOT='/opt/nav-stack/releases'
readonly CANONICAL_BACKUP_LOCK_FILE='/run/lock/nav-backup.lock'
readonly CLI_PATH='./src/ops/releaseAcceptanceAccountCli.js'
readonly CONTROL_TIMEOUT_SECONDS=30

PROGRAM_NAME="$(basename "$0")"
RELEASE_DIR=''
API_CONTAINER=''
DATABASE_CONTAINER=''
DATABASE_NAME=''
DATABASE_USER=''
EXPECTED_RELEASE_SHA=''
EVIDENCE_FILE=''
ACCEPTANCE_TIMEOUT_SECONDS=''
RELEASES_ROOT="${NAV_RELEASES_ROOT:-$DEFAULT_RELEASES_ROOT}"
BACKUP_LOCK_FILE="$CANONICAL_BACKUP_LOCK_FILE"
STATE_DIR=''
STATE_FILE=''
SECRET_DIR=''
USERNAME_FILE=''
PASSWORD_FILE=''
COMMAND_STATUS=70
ACCEPTANCE_PID=''
SIGNAL_STATUS=0
LIFECYCLE_STARTED=false
FINALIZING=false
readonly RELEASE_LOCK_FD=9
readonly BACKUP_LOCK_FD=8
COMMAND=()
ACCEPTANCE_CLIENT_IPS=()

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

fatal() {
  local code="$1"
  shift
  log "$*"
  exit "$code"
}

run_control() {
  timeout --signal=TERM --kill-after=5s "${CONTROL_TIMEOUT_SECONDS}s" "$@"
}

usage() {
  cat <<'EOF'
Usage:
  nav-with-ephemeral-admin.sh \
    --release-dir /opt/nav-stack/releases/<release> \
    --api-container <candidate-api-container> \
    --database-container <production-postgres-container> \
    --database-name <production-database-name> \
    --database-user <production-database-user> \
    --expected-release-sha <40-hex-merge-sha> \
    --timeout-seconds <30-1200> \
    --client-ip <acceptance-egress-ip> [--client-ip <additional-ip>] \
    --evidence-file /opt/nav-stack/releases/<release>/evidence/<name>.txt \
    -- <acceptance-command> [args...]

The acceptance command receives only credential file paths:
  NAV_ACCEPTANCE_USERNAME_FILE
  NAV_ACCEPTANCE_PASSWORD_FILE
  NAV_ACCEPTANCE_RUN_ID
  NAV_ACCEPTANCE_EPHEMERAL=true

The wrapper never reads or overwrites the real administrator credential files.
EOF
}

while (($# > 0)); do
  case "$1" in
    --release-dir)
      (($# >= 2)) || fatal "$EX_USAGE" '--release-dir requires a value'
      RELEASE_DIR="$2"
      shift 2
      ;;
    --api-container)
      (($# >= 2)) || fatal "$EX_USAGE" '--api-container requires a value'
      API_CONTAINER="$2"
      shift 2
      ;;
    --database-container)
      (($# >= 2)) || fatal "$EX_USAGE" '--database-container requires a value'
      DATABASE_CONTAINER="$2"
      shift 2
      ;;
    --database-name)
      (($# >= 2)) || fatal "$EX_USAGE" '--database-name requires a value'
      DATABASE_NAME="$2"
      shift 2
      ;;
    --database-user)
      (($# >= 2)) || fatal "$EX_USAGE" '--database-user requires a value'
      DATABASE_USER="$2"
      shift 2
      ;;
    --expected-release-sha)
      (($# >= 2)) || fatal "$EX_USAGE" '--expected-release-sha requires a value'
      EXPECTED_RELEASE_SHA="${2,,}"
      shift 2
      ;;
    --timeout-seconds)
      (($# >= 2)) || fatal "$EX_USAGE" '--timeout-seconds requires a value'
      ACCEPTANCE_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --client-ip)
      (($# >= 2)) || fatal "$EX_USAGE" '--client-ip requires a value'
      ACCEPTANCE_CLIENT_IPS+=("$2")
      shift 2
      ;;
    --evidence-file)
      (($# >= 2)) || fatal "$EX_USAGE" '--evidence-file requires a value'
      EVIDENCE_FILE="$2"
      shift 2
      ;;
    --)
      shift
      COMMAND=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fatal "$EX_USAGE" "unsupported argument: $1"
      ;;
  esac
done

[[ -n "$RELEASE_DIR" ]] || fatal "$EX_USAGE" '--release-dir is required'
[[ -n "$API_CONTAINER" ]] || fatal "$EX_USAGE" '--api-container is required'
[[ -n "$DATABASE_CONTAINER" ]] || fatal "$EX_USAGE" '--database-container is required'
[[ -n "$DATABASE_NAME" ]] || fatal "$EX_USAGE" '--database-name is required'
[[ -n "$DATABASE_USER" ]] || fatal "$EX_USAGE" '--database-user is required'
[[ -n "$EXPECTED_RELEASE_SHA" ]] || fatal "$EX_USAGE" '--expected-release-sha is required'
[[ -n "$ACCEPTANCE_TIMEOUT_SECONDS" ]] || fatal "$EX_USAGE" '--timeout-seconds is required'
(( ${#ACCEPTANCE_CLIENT_IPS[@]} > 0 && ${#ACCEPTANCE_CLIENT_IPS[@]} <= 8 )) \
  || fatal "$EX_USAGE" 'one to eight --client-ip values are required'
[[ -n "$EVIDENCE_FILE" ]] || fatal "$EX_USAGE" '--evidence-file is required'
((${#COMMAND[@]} > 0)) || fatal "$EX_USAGE" 'an acceptance command is required after --'
[[ "$API_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fatal "$EX_CONFIG" 'API container name is invalid'
[[ "$DATABASE_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fatal "$EX_CONFIG" 'database container name is invalid'
[[ "$DATABASE_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || fatal "$EX_CONFIG" 'database name is invalid'
[[ "$DATABASE_USER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
  || fatal "$EX_CONFIG" 'database user is invalid'
[[ "$EXPECTED_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || fatal "$EX_CONFIG" 'expected release SHA must contain exactly 40 lowercase hexadecimal characters'
[[ "$ACCEPTANCE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  || fatal "$EX_CONFIG" 'acceptance timeout must be an integer number of seconds'
(( ACCEPTANCE_TIMEOUT_SECONDS >= 30 && ACCEPTANCE_TIMEOUT_SECONDS <= 1200 )) \
  || fatal "$EX_CONFIG" 'acceptance timeout must be between 30 and 1200 seconds'
if [[ -v NAV_BACKUP_LOCK_FILE && "$NAV_BACKUP_LOCK_FILE" != "$CANONICAL_BACKUP_LOCK_FILE" ]]; then
  fatal "$EX_CONFIG" "NAV_BACKUP_LOCK_FILE must remain $CANONICAL_BACKUP_LOCK_FILE"
fi

for dependency in docker flock openssl python3 realpath stat install setsid timeout sleep; do
  command -v "$dependency" >/dev/null 2>&1 \
    || fatal "$EX_CONFIG" "required command is unavailable: $dependency"
done
[[ "$EUID" == 0 ]] || fatal "$EX_CONFIG" 'release acceptance must run as root'

python3 - "${ACCEPTANCE_CLIENT_IPS[@]}" <<'PY' \
  || fatal "$EX_CONFIG" 'acceptance client IP list is invalid'
import ipaddress, sys
values = sys.argv[1:]
if len(values) != len(set(value.strip().lower() for value in values)):
    raise SystemExit(1)
for value in values:
    ipaddress.ip_address(value.strip())
PY

[[ "$RELEASE_DIR" == /* && "$RELEASES_ROOT" == /* && "$EVIDENCE_FILE" == /* ]] \
  || fatal "$EX_CONFIG" 'release, releases root and evidence paths must be absolute'
[[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] \
  || fatal "$EX_CONFIG" 'release directory must be an existing non-symlink directory'
[[ -d "$RELEASES_ROOT" && ! -L "$RELEASES_ROOT" ]] \
  || fatal "$EX_CONFIG" 'releases root must be an existing non-symlink directory'

release_real="$(realpath -e -- "$RELEASE_DIR")"
releases_root_real="$(realpath -e -- "$RELEASES_ROOT")"
[[ "$release_real" == "$releases_root_real"/* ]] \
  || fatal "$EX_CONFIG" 'release directory is outside the configured releases root'
[[ "$(basename -- "$release_real")" == *-"${EXPECTED_RELEASE_SHA:0:7}" ]] \
  || fatal "$EX_CONFIG" 'release directory does not match the expected merge SHA'
[[ "$(stat -c '%u' -- "$release_real")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" 'release directory has the wrong owner'
release_mode="$(stat -c '%a' -- "$release_real")"
(( (8#$release_mode & 022) == 0 )) \
  || fatal "$EX_CONFIG" 'release directory must not be group/world writable'

evidence_parent="$(dirname -- "$EVIDENCE_FILE")"
[[ -d "$evidence_parent" && ! -L "$evidence_parent" ]] \
  || fatal "$EX_CONFIG" 'evidence parent must be an existing non-symlink directory'
evidence_parent_real="$(realpath -e -- "$evidence_parent")"
[[ "$evidence_parent_real" == "$release_real/evidence" ]] \
  || fatal "$EX_CONFIG" 'evidence file must be directly inside the release evidence directory'
[[ "$(stat -c '%u' -- "$evidence_parent_real")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" 'evidence directory has the wrong owner'
evidence_mode="$(stat -c '%a' -- "$evidence_parent_real")"
(( (8#$evidence_mode & 022) == 0 )) \
  || fatal "$EX_CONFIG" 'evidence directory must not be group/world writable'
evidence_name="$(basename -- "$EVIDENCE_FILE")"
[[ "$evidence_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fatal "$EX_CONFIG" 'evidence filename is invalid'
EVIDENCE_FILE="$evidence_parent_real/$evidence_name"
[[ ! -e "$EVIDENCE_FILE" && ! -L "$EVIDENCE_FILE" ]] \
  || fatal "$EX_CANTCREAT" 'refusing to overwrite an existing evidence file'

prepare_lock_file() {
  local path="$1"
  local label="$2"
  local parent parent_mode
  [[ "$path" == /run/lock/* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] \
    || fatal "$EX_CONFIG" "$label lock path must be directly below /run/lock"
  parent="$(dirname -- "$path")"
  if [[ ! -e "$parent" && ! -L "$parent" ]]; then
    install -d -m 0755 -- "$parent"
  fi
  [[ -d "$parent" && ! -L "$parent" && "$(realpath -e -- "$parent")" == /run/lock ]] \
    || fatal "$EX_CONFIG" "$label lock parent is unsafe"
  [[ "$(stat -c '%u' -- "$parent")" == 0 ]] \
    || fatal "$EX_CONFIG" "$label lock parent must be root-owned"
  parent_mode="$(stat -c '%a' -- "$parent")"
  (( (8#$parent_mode & 022) == 0 || (8#$parent_mode & 01000) != 0 )) \
    || fatal "$EX_CONFIG" "writable $label lock parent must have the sticky bit"
  python3 - "$path" <<'PY' \
    || fatal "$EX_CONFIG" "$label lock is unsafe"
import os
import stat
import sys

path = sys.argv[1]
fd = os.open(
    path,
    os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW,
    0o600
)
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
}

release_lock_file='/run/lock/nav-release.lock'
prepare_lock_file "$release_lock_file" 'release'
exec 9>>"$release_lock_file"
chmod 0600 "$release_lock_file"
flock -n "$RELEASE_LOCK_FD" \
  || fatal "$EX_TEMPFAIL" 'another NAV acceptance lifecycle is already running'

prepare_lock_file "$BACKUP_LOCK_FILE" 'backup'
exec 8>>"$BACKUP_LOCK_FILE"
chmod 0600 "$BACKUP_LOCK_FILE"
flock -n "$BACKUP_LOCK_FD" \
  || fatal "$EX_TEMPFAIL" 'a NAV backup is already running'

container_status="$(run_control docker inspect -f '{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || true)"
container_health="$(run_control docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
container_revision="$(run_control docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$API_CONTAINER" 2>/dev/null || true)"
[[ "$container_status" == running && "$container_health" == healthy ]] \
  || fatal "$EX_CONFIG" 'candidate API container is not running and healthy'
[[ "${container_revision,,}" == "$EXPECTED_RELEASE_SHA" ]] \
  || fatal "$EX_CONFIG" 'candidate API container revision does not match the expected merge SHA'
run_control docker exec "$API_CONTAINER" test -f "$CLI_PATH" \
  || fatal "$EX_CONFIG" 'candidate API image does not contain release acceptance tooling'

database_status="$(run_control docker inspect -f '{{.State.Status}}' "$DATABASE_CONTAINER" 2>/dev/null || true)"
database_health="$(run_control docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$DATABASE_CONTAINER" 2>/dev/null || true)"
[[ "$database_status" == running && "$database_health" == healthy ]] \
  || fatal "$EX_CONFIG" 'production database container is not running and healthy'
database_addresses="$(run_control docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}' "$DATABASE_CONTAINER" 2>/dev/null || true)"
[[ -n "$database_addresses" ]] \
  || fatal "$EX_CONFIG" 'production database container has no inspectable network address'
database_direct_identity="$(
  run_control docker exec "$DATABASE_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$DATABASE_USER" -d "$DATABASE_NAME" \
    -AtF $'\t' -c \
    "SELECT current_database(),
            (SELECT oid::text FROM pg_database WHERE datname = current_database()),
            current_setting('server_version_num');"
)" || fatal "$EX_CONFIG" 'could not read the selected production database identity'

STATE_DIR="$release_real/runtime/release-acceptance"
STATE_FILE="$STATE_DIR/state.json"

assert_state_dir() {
  local state_real state_mode state_owner
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || return 1
  state_real="$(realpath -e -- "$STATE_DIR")"
  [[ "$state_real" == "$release_real/runtime/release-acceptance" ]] || return 1
  state_mode="$(stat -c '%a' -- "$state_real")"
  state_owner="$(stat -c '%u' -- "$state_real")"
  [[ "$state_mode" == 700 && "$state_owner" == "$EUID" ]]
}

remove_state_dir() {
  local state_real
  [[ -e "$STATE_DIR" ]] || return 0
  assert_state_dir || return 1
  state_real="$(realpath -e -- "$STATE_DIR")"
  [[ "$state_real" == "$release_real/runtime/release-acceptance" ]] || return 1
  rm -rf -- "$state_real"
}

assert_secret_dir() {
  local secret_real secret_mode secret_owner
  [[ -n "$SECRET_DIR" && -d "$SECRET_DIR" && ! -L "$SECRET_DIR" ]] || return 1
  secret_real="$(realpath -e -- "$SECRET_DIR")"
  [[ "$secret_real" == /run/nav-release-acceptance.* ]] || return 1
  secret_mode="$(stat -c '%a' -- "$secret_real")"
  secret_owner="$(stat -c '%u' -- "$secret_real")"
  [[ "$secret_mode" == 700 && "$secret_owner" == "$EUID" ]]
}

remove_secret_dir() {
  local secret_real
  [[ -n "$SECRET_DIR" && -e "$SECRET_DIR" ]] || return 0
  assert_secret_dir || return 1
  secret_real="$(realpath -e -- "$SECRET_DIR")"
  [[ "$secret_real" == /run/nav-release-acceptance.* ]] || return 1
  rm -rf -- "$secret_real"
  SECRET_DIR=''
}

cleanup_account() {
  local cleanup_input cleanup_output
  if [[ ! -e "$STATE_FILE" ]]; then
    local empty_status
    empty_status="$STATE_DIR/status-without-state.json"
    assert_state_dir || return 1
    run_control docker exec "$API_CONTAINER" node "$CLI_PATH" status > "$empty_status" || return 1
    chmod 600 "$empty_status"
    python3 - "$empty_status" <<'PY' || return 1
import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
if data.get('ok') is not True:
    raise SystemExit(1)
if int(data.get('markerCount') or 0) != 0 or int(data.get('userCount') or 0) != 0:
    raise SystemExit(1)
PY
    remove_state_dir
    return
  fi
  [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || return 1
  assert_state_dir || return 1
  cleanup_input="$STATE_DIR/cleanup-input.json"
  cleanup_output="$STATE_DIR/cleanup-output.json"
  python3 - "$STATE_FILE" "$cleanup_input" <<'PY' || return 1
import json, os, re, sys
state_path, output_path = sys.argv[1:]
state = json.load(open(state_path, encoding='utf-8'))
if state.get('version') != 2 or state.get('phase') not in ('planned', 'provisioned'):
    raise SystemExit(1)
run_id = str(state.get('runId') or '').lower()
username = str(state.get('username') or '').lower()
if not re.fullmatch(r'[0-9a-f]{48}', run_id):
    raise SystemExit(1)
if not re.fullmatch(r'nav_release_accept_[0-9a-f]{32}', username):
    raise SystemExit(1)
payload = {'runId': run_id, 'expectedUsername': username}
if state.get('phase') == 'provisioned':
    user_id = str(state.get('userId') or '').lower()
    if not re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
        user_id
    ):
        raise SystemExit(1)
    payload['expectedUserId'] = user_id
with open(output_path, 'w', encoding='utf-8') as output:
    json.dump(payload, output, separators=(',', ':'))
PY
  chmod 600 "$cleanup_input"
  if ! run_control docker exec -i "$API_CONTAINER" node "$CLI_PATH" cleanup \
    < "$cleanup_input" > "$cleanup_output"; then
    return 1
  fi
  chmod 600 "$cleanup_output"
  python3 - "$STATE_FILE" "$cleanup_output" <<'PY'
import json, sys
state = json.load(open(sys.argv[1], encoding='utf-8'))
data = json.load(open(sys.argv[2], encoding='utf-8'))
if data.get('ok') is not True:
    raise SystemExit(1)
cleaned = data.get('cleaned') is True
marker_missing = data.get('markerMissing') is True
users_removed = int(data.get('usersRemoved') or 0)
if state.get('phase') == 'provisioned':
    if not cleaned or marker_missing or users_removed != 1:
        raise SystemExit(1)
elif not (
    (cleaned and not marker_missing and users_removed == 1)
    or (not cleaned and marker_missing and users_removed == 0)
):
    raise SystemExit(1)
PY

  remove_state_dir
}

write_evidence() {
  local status="$1"
  local acceptance_exit="$2"
  local cleanup_status="$3"
  local staging
  staging="$(mktemp "$evidence_parent_real/.acceptance-account.XXXXXX")"
  printf '%s\n' \
    "status=$status" \
    "finished_at_utc=$(date -u +%FT%TZ)" \
    "acceptance_exit=$acceptance_exit" \
    "cleanup=$cleanup_status" \
    'credential_values=not-recorded' \
    'real_admin_credentials=not-read-or-modified' \
    > "$staging"
  chmod 600 "$staging"
  install -m 600 "$staging" "$EVIDENCE_FILE"
  rm -f -- "$staging"
}

finalize() {
  local original_status="$?"
  local cleanup_status='PASS'
  local final_status="$original_status"
  local evidence_status='FAIL'

  "$FINALIZING" && exit "$original_status"
  FINALIZING=true
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if "$LIFECYCLE_STARTED" || [[ -e "$STATE_DIR" ]]; then
    cleanup_account
    cleanup_exit="$?"
    if ((cleanup_exit != 0)); then
      cleanup_status='FAIL'
      final_status="$EX_SOFTWARE"
      log 'ephemeral administrator cleanup failed; non-secret marker state was retained for exact recovery'
    fi
  fi
  remove_secret_dir
  secret_cleanup_exit="$?"
  if ((secret_cleanup_exit != 0)); then
    cleanup_status='FAIL'
    final_status="$EX_SOFTWARE"
    log 'ephemeral credential directory cleanup failed'
  fi
  if ((original_status == 0 && final_status == 0)); then
    evidence_status='PASS'
  fi
  write_evidence "$evidence_status" "$original_status" "$cleanup_status" || final_status="$EX_CANTCREAT"
  if ((final_status == 0)); then
    log 'ephemeral administrator acceptance lifecycle completed and cleaned'
  else
    log "acceptance lifecycle failed with status $final_status"
  fi
  exit "$final_status"
}

handle_signal() {
  local signal_name="$1"
  local signal_status="$2"

  if ((SIGNAL_STATUS == 0)); then
    SIGNAL_STATUS="$signal_status"
  fi
  if [[ "$ACCEPTANCE_PID" =~ ^[0-9]+$ ]]; then
    kill -s "$signal_name" -- "-$ACCEPTANCE_PID" 2>/dev/null \
      || kill -s "$signal_name" "$ACCEPTANCE_PID" 2>/dev/null \
      || true
    return
  fi
  exit "$signal_status"
}

stop_acceptance_group() {
  local attempt

  [[ "$ACCEPTANCE_PID" =~ ^[0-9]+$ ]] || return 0
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    kill -0 -- "-$ACCEPTANCE_PID" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$ACCEPTANCE_PID" 2>/dev/null \
    || kill -KILL "$ACCEPTANCE_PID" 2>/dev/null \
    || true
}

trap finalize EXIT
trap 'handle_signal HUP 129' HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

runtime_parent="$release_real/runtime"
if [[ -e "$runtime_parent" ]]; then
  [[ -d "$runtime_parent" && ! -L "$runtime_parent" ]] \
    || fatal "$EX_CONFIG" 'release runtime path is unsafe'
  [[ "$(realpath -e -- "$runtime_parent")" == "$release_real/runtime" ]] \
    || fatal "$EX_CONFIG" 'release runtime path resolves outside the release'
  [[ "$(stat -c '%u' -- "$runtime_parent")" == "$EUID" ]] \
    || fatal "$EX_CONFIG" 'release runtime path has the wrong owner'
else
  mkdir -- "$runtime_parent"
fi
chmod 700 "$runtime_parent"

if ! database_status_json="$(run_control docker exec "$API_CONTAINER" node "$CLI_PATH" status)"; then
  fatal "$EX_SOFTWARE" 'could not inspect candidate API database target'
fi
if ! python3 - \
  "$database_status_json" \
  "$DATABASE_NAME" \
  "$database_addresses" \
  "$database_direct_identity" <<'PY'
import ipaddress, json, re, sys
raw_status, expected_name, raw_addresses, direct_identity = sys.argv[1:]
data = json.loads(raw_status)
direct_parts = direct_identity.split('\t')
if len(direct_parts) != 3:
    raise SystemExit(1)
direct_name, direct_oid, direct_version = direct_parts
addresses = {
    str(ipaddress.ip_address(value.strip()))
    for value in raw_addresses.splitlines()
    if value.strip()
}
server_address = str(data.get('databaseServerAddress') or '').strip()
if data.get('ok') is not True:
    raise SystemExit(1)
if data.get('databaseName') != expected_name or direct_name != expected_name:
    raise SystemExit(1)
if not re.fullmatch(r'[0-9]+', direct_oid):
    raise SystemExit(1)
if str(data.get('databaseOid') or '') != direct_oid:
    raise SystemExit(1)
if not re.fullmatch(r'16[0-9]{4}', direct_version):
    raise SystemExit(1)
if str(data.get('serverVersionNum') or '') != direct_version:
    raise SystemExit(1)
if not server_address:
    raise SystemExit(1)
server_interface = ipaddress.ip_interface(server_address)
if server_interface.network.prefixlen != server_interface.max_prefixlen:
    raise SystemExit(1)
if str(server_interface.ip) not in addresses:
    raise SystemExit(1)
if int(data.get('databaseServerPort') or 0) != 5432:
    raise SystemExit(1)
PY
then
  fatal "$EX_CONFIG" 'candidate API is not connected to the selected PostgreSQL 16 container'
fi
unset database_status_json

# A state directory can survive SIGKILL or host loss. The host lock proves no
# same-host wrapper is active, so clean only the exact database marker before a
# new account is created. Untracked prefix residue makes the CLI fail closed.
if [[ -e "$STATE_DIR" ]]; then
  assert_state_dir \
    || fatal "$EX_CONFIG" 'stale acceptance state directory is unsafe'
  cleanup_account \
    || fatal "$EX_SOFTWARE" 'stale acceptance account could not be reconciled'
fi

status_file="$(mktemp "$release_real/runtime/.acceptance-status.XXXXXX")"
if ! run_control docker exec "$API_CONTAINER" node "$CLI_PATH" status > "$status_file"; then
  rm -f -- "$status_file"
  fatal "$EX_SOFTWARE" 'could not inspect acceptance account residue'
fi
if ! python3 - "$status_file" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
if data.get('ok') is not True:
    raise SystemExit(1)
if int(data.get('markerCount') or 0) != 0 or int(data.get('userCount') or 0) != 0:
    raise SystemExit(1)
PY
then
  rm -f -- "$status_file"
  fatal "$EX_CONFIG" 'untracked acceptance account residue is present'
fi
rm -f -- "$status_file"

[[ -d /run && ! -L /run && "$(realpath -e -- /run)" == /run ]] \
  || fatal "$EX_CONFIG" '/run is unavailable or unsafe'
[[ "$(stat -c '%u' -- /run)" == 0 ]] \
  || fatal "$EX_CONFIG" '/run must be root-owned'
mkdir -- "$STATE_DIR"
chmod 700 "$STATE_DIR"
SECRET_DIR="$(mktemp -d /run/nav-release-acceptance.XXXXXX)"
chmod 700 "$SECRET_DIR"
assert_secret_dir || fatal "$EX_CANTCREAT" 'ephemeral credential directory is unsafe'
USERNAME_FILE="$SECRET_DIR/username"
PASSWORD_FILE="$SECRET_DIR/password"
run_id="$(openssl rand -hex 24)"
username="nav_release_accept_$(openssl rand -hex 16)"
openssl rand -base64 48 | tr -d '\n' > "$PASSWORD_FILE"
printf '%s' "$username" > "$USERNAME_FILE"
printf '{"version":2,"phase":"planned","runId":"%s","username":"%s"}\n' "$run_id" "$username" > "$STATE_FILE"
chmod 600 "$PASSWORD_FILE" "$USERNAME_FILE" "$STATE_FILE"
unset username
LIFECYCLE_STARTED=true

provision_output="$STATE_DIR/provision-output.json"
python3 - "$STATE_FILE" "$USERNAME_FILE" "$PASSWORD_FILE" "${ACCEPTANCE_CLIENT_IPS[@]}" <<'PY' \
  | run_control docker exec -i "$API_CONTAINER" node "$CLI_PATH" provision > "$provision_output"
import json, sys
state = json.load(open(sys.argv[1], encoding='utf-8'))
username = open(sys.argv[2], encoding='utf-8').read()
password = open(sys.argv[3], encoding='utf-8').read()
print(json.dumps({
    'runId': state['runId'],
    'username': username,
    'password': password,
    'clientIps': sys.argv[4:]
}), end='')
PY
chmod 600 "$provision_output"
python3 - "$STATE_FILE" "$provision_output" <<'PY'
import json, os, re, sys, tempfile
state_path, result_path = sys.argv[1:]
state = json.load(open(state_path, encoding='utf-8'))
result = json.load(open(result_path, encoding='utf-8'))
user_id = str(result.get('userId') or '').lower()
if result.get('ok') is not True or not re.fullmatch(
    r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
    user_id
):
    raise SystemExit(1)
state['userId'] = user_id
state['phase'] = 'provisioned'
fd, temp_path = tempfile.mkstemp(prefix='.state.', dir=os.path.dirname(state_path))
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        json.dump(state, output, separators=(',', ':'))
        output.write('\n')
    os.replace(temp_path, state_path)
finally:
    if os.path.exists(temp_path):
        os.unlink(temp_path)
PY
rm -f -- "$provision_output"

export NAV_ACCEPTANCE_USERNAME_FILE="$USERNAME_FILE"
export NAV_ACCEPTANCE_PASSWORD_FILE="$PASSWORD_FILE"
export NAV_ACCEPTANCE_RUN_ID="$run_id"
export NAV_ACCEPTANCE_EPHEMERAL=true

set +e
setsid timeout \
  --signal=TERM \
  --kill-after=5s \
  "${ACCEPTANCE_TIMEOUT_SECONDS}s" \
  "${COMMAND[@]}" &
ACCEPTANCE_PID="$!"
wait "$ACCEPTANCE_PID"
COMMAND_STATUS="$?"
if ((SIGNAL_STATUS != 0)); then
  trap - HUP INT TERM
  stop_acceptance_group
  wait "$ACCEPTANCE_PID" 2>/dev/null || true
  COMMAND_STATUS="$SIGNAL_STATUS"
fi
ACCEPTANCE_PID=''
set -e
exit "$COMMAND_STATUS"
