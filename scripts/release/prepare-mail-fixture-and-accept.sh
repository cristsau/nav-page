#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_SOFTWARE=70
readonly EX_CONFIG=78
readonly CLI_PATH='./src/ops/mailAcceptanceFixtureCli.js'

PROGRAM_NAME="$(basename "$0")"
readonly PROGRAM_NAME
SCRIPT_DIR="$(realpath -e -- "$(dirname -- "$0")")"
readonly SCRIPT_DIR
ACCEPT_SCRIPT="$SCRIPT_DIR/accept-mail-workspace.sh"
API_CONTAINER="${NAV_ACCEPTANCE_API_CONTAINER:-}"
DATABASE_CONTAINER="${NAV_ACCEPTANCE_DATABASE_CONTAINER:-}"
DATABASE_NAME="${NAV_ACCEPTANCE_DATABASE_NAME:-}"
DATABASE_USER="${NAV_ACCEPTANCE_DATABASE_USER:-}"
RUN_ID="${NAV_ACCEPTANCE_RUN_ID:-}"
MARKER="${NAV_MAIL_ACCEPTANCE_MARKER:-navmail.${RUN_ID}}"
TMP_DIR=''
PREPARED=false
ACCOUNT_ID=''
FOLDER_ID=''
MESSAGE_ID=''
LOCATION_ID=''
FINALIZING=false

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

fatal() {
  local code="$1"
  shift
  log "$*"
  exit "$code"
}

require_env() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || fatal "$EX_CONFIG" "$name is required"
}

fixture_request() {
  local command="$1"
  local input_file="$2"
  local output_file="$3"
  if ! docker exec -i "$API_CONTAINER" node "$CLI_PATH" "$command" \
    < "$input_file" > "$output_file"; then
    return 1
  fi
  chmod 0600 "$output_file"
  jq -e . "$output_file" >/dev/null
}

write_fixture_input() {
  local output_file="$1"
  local include_ids="$2"
  local -a args=(
    -n
    --rawfile username "$NAV_ACCEPTANCE_USERNAME_FILE"
    --arg runId "$RUN_ID"
    --arg marker "$MARKER"
  )
  local filter='{
    runId: $runId,
    username: ($username | gsub("[\\r\\n]+$"; "")),
    marker: $marker
  }'
  if [[ "$include_ids" == true ]]; then
    args+=(
      --arg accountId "$ACCOUNT_ID"
      --arg folderId "$FOLDER_ID"
      --arg messageId "$MESSAGE_ID"
      --arg locationId "$LOCATION_ID"
    )
    filter='{
      runId: $runId,
      username: ($username | gsub("[\\r\\n]+$"; "")),
      marker: $marker,
      accountId: $accountId,
      folderId: $folderId,
      messageId: $messageId,
      locationId: $locationId
    }'
  fi
  jq "${args[@]}" "$filter" > "$output_file"
  chmod 0600 "$output_file"
}

cleanup_fixture() {
  local cleanup_input="$TMP_DIR/cleanup-input.json"
  local cleanup_output="$TMP_DIR/cleanup-output.json"
  write_fixture_input "$cleanup_input" true || return 1
  fixture_request cleanup "$cleanup_input" "$cleanup_output" || return 1
  jq -e '.ok == true and .cleaned == true' "$cleanup_output" >/dev/null
}

finalize() {
  local original_status="$?"
  local final_status="$original_status"
  local cleanup_status=PASS
  "$FINALIZING" && exit "$original_status"
  FINALIZING=true
  trap - EXIT HUP INT TERM
  set +e

  if "$PREPARED"; then
    cleanup_fixture || cleanup_status=FAIL
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" && ! -L "$TMP_DIR" && "$TMP_DIR" == /run/nav-mail-fixture.* ]]; then
    rm -rf -- "$TMP_DIR" || cleanup_status=FAIL
  else
    cleanup_status=FAIL
  fi
  if [[ "$cleanup_status" != PASS ]]; then
    final_status="$EX_SOFTWARE"
    log 'synthetic mail fixture cleanup failed; wrapper account cascade remains the final bounded fallback'
  fi
  exit "$final_status"
}

[[ "${NAV_ACCEPTANCE_EPHEMERAL:-}" == true ]] \
  || fatal "$EX_CONFIG" 'fixture orchestration must be wrapped by nav-with-ephemeral-admin.sh'
[[ "$EUID" == 0 ]] || fatal "$EX_CONFIG" 'fixture orchestration must run as root'
require_env NAV_ACCEPTANCE_USERNAME_FILE "${NAV_ACCEPTANCE_USERNAME_FILE:-}"
require_env NAV_ACCEPTANCE_PASSWORD_FILE "${NAV_ACCEPTANCE_PASSWORD_FILE:-}"
require_env NAV_ACCEPTANCE_RUN_ID "$RUN_ID"
require_env NAV_ACCEPTANCE_API_CONTAINER "$API_CONTAINER"
require_env NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL "${NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL:-}"
require_env NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL "${NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL:-}"
require_env NAV_ACCEPTANCE_DATABASE_CONTAINER "$DATABASE_CONTAINER"
require_env NAV_ACCEPTANCE_DATABASE_NAME "$DATABASE_NAME"
require_env NAV_ACCEPTANCE_DATABASE_USER "$DATABASE_USER"

[[ "$RUN_ID" =~ ^[0-9a-f]{48}$ ]] \
  || fatal "$EX_CONFIG" 'NAV_ACCEPTANCE_RUN_ID is invalid'
[[ "$MARKER" == "navmail.$RUN_ID" ]] \
  || fatal "$EX_CONFIG" 'NAV_MAIL_ACCEPTANCE_MARKER must match the current acceptance run'
[[ "$API_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fatal "$EX_CONFIG" 'NAV_MAIL_ACCEPTANCE_API_CONTAINER is invalid'

for dependency in docker jq mktemp chmod rm realpath stat date; do
  command -v "$dependency" >/dev/null 2>&1 \
    || fatal "$EX_CONFIG" "required command is unavailable: $dependency"
done
for credential_file in "$NAV_ACCEPTANCE_USERNAME_FILE" "$NAV_ACCEPTANCE_PASSWORD_FILE"; do
  [[ "$credential_file" == /* && -f "$credential_file" && ! -L "$credential_file" && -s "$credential_file" ]] \
    || fatal "$EX_CONFIG" 'ephemeral credential file is missing or unsafe'
  [[ "$(stat -c '%u:%a' -- "$credential_file")" == "0:600" ]] \
    || fatal "$EX_CONFIG" 'ephemeral credential file ownership or mode is unsafe'
done
[[ -f "$ACCEPT_SCRIPT" && ! -L "$ACCEPT_SCRIPT" && -x "$ACCEPT_SCRIPT" ]] \
  || fatal "$EX_CONFIG" 'mail acceptance script is missing or unsafe'
docker exec "$API_CONTAINER" test -f "$CLI_PATH" \
  || fatal "$EX_CONFIG" 'candidate API image does not contain mail fixture tooling'

[[ -d /run && ! -L /run && "$(realpath -e -- /run)" == /run ]] \
  || fatal "$EX_CONFIG" '/run is unavailable or unsafe'
TMP_DIR="$(mktemp -d /run/nav-mail-fixture.XXXXXX)"
chmod 0700 "$TMP_DIR"
trap finalize EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_input="$TMP_DIR/prepare-input.json"
prepare_output="$TMP_DIR/prepare-output.json"
write_fixture_input "$prepare_input" false
fixture_request prepare "$prepare_input" "$prepare_output" \
  || fatal "$EX_SOFTWARE" 'synthetic mail fixture preparation failed'

jq -e --arg marker "$MARKER" '
  .ok == true
  and .marker == $marker
  and ([.accountId, .folderId, .messageId, .locationId]
    | all(.[]; test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")))
' "$prepare_output" >/dev/null \
  || fatal "$EX_SOFTWARE" 'synthetic mail fixture result is invalid'

ACCOUNT_ID="$(jq -r '.accountId' "$prepare_output")"
FOLDER_ID="$(jq -r '.folderId' "$prepare_output")"
MESSAGE_ID="$(jq -r '.messageId' "$prepare_output")"
LOCATION_ID="$(jq -r '.locationId' "$prepare_output")"
PREPARED=true

env \
  NAV_MAIL_ACCEPTANCE_FIXTURE_MODE=required \
  NAV_MAIL_ACCEPTANCE_MARKER="$MARKER" \
  NAV_MAIL_ACCEPTANCE_ACCOUNT_ID="$ACCOUNT_ID" \
  NAV_MAIL_ACCEPTANCE_FOLDER_ID="$FOLDER_ID" \
  NAV_MAIL_ACCEPTANCE_MESSAGE_ID="$MESSAGE_ID" \
  NAV_MAIL_ACCEPTANCE_DATABASE_CONTAINER="$DATABASE_CONTAINER" \
  NAV_MAIL_ACCEPTANCE_DATABASE_NAME="$DATABASE_NAME" \
  NAV_MAIL_ACCEPTANCE_DATABASE_USER="$DATABASE_USER" \
  "$ACCEPT_SCRIPT"
