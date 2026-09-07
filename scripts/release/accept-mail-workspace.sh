#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_SOFTWARE=70
readonly EX_SKIP=77
readonly EX_CONFIG=78
PROGRAM_NAME="$(basename "$0")"
readonly PROGRAM_NAME
readonly UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
readonly SHA256_PATTERN='^[0-9a-f]{64}$'

PRIMARY_BASE_URL="${NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL:-}"
SECONDARY_BASE_URL="${NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL:-}"
FIXTURE_MODE="${NAV_MAIL_ACCEPTANCE_FIXTURE_MODE:-required}"
MARKER="${NAV_MAIL_ACCEPTANCE_MARKER:-}"
ACCOUNT_ID="${NAV_MAIL_ACCEPTANCE_ACCOUNT_ID:-}"
FOLDER_ID="${NAV_MAIL_ACCEPTANCE_FOLDER_ID:-}"
MESSAGE_ID="${NAV_MAIL_ACCEPTANCE_MESSAGE_ID:-}"
DB_CONTAINER="${NAV_MAIL_ACCEPTANCE_DATABASE_CONTAINER:-}"
DB_NAME="${NAV_MAIL_ACCEPTANCE_DATABASE_NAME:-}"
DB_USER="${NAV_MAIL_ACCEPTANCE_DATABASE_USER:-}"
HTTP_TIMEOUT_SECONDS="${NAV_MAIL_ACCEPTANCE_HTTP_TIMEOUT_SECONDS:-30}"

TMP_DIR=''
PRIMARY_COOKIE_JAR=''
SECONDARY_COOKIE_JAR=''
PRIMARY_LOGGED_IN=false
SECONDARY_LOGGED_IN=false
CREATED_RULE_ID=''
CREATED_DRAFT_ID=''
EPHEMERAL_USER_ID=''
OUTBOX_BEFORE=''
OUTBOX_AFTER=''
REMOTE_COMMAND_QUEUE='NOT_RECORDED'
FINALIZING=false
SUMMARY_WRITTEN=false

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

safe_summary() {
  local status="$1"
  local cleanup="$2"
  "$SUMMARY_WRITTEN" && return 0
  SUMMARY_WRITTEN=true
  printf '%s\n' \
    "status=$status" \
    "cleanup=$cleanup" \
    "mail_outbox_before=${OUTBOX_BEFORE:-NOT_RECORDED}" \
    "mail_outbox_after=${OUTBOX_AFTER:-NOT_RECORDED}" \
    "remote_command_queue=${REMOTE_COMMAND_QUEUE:-NOT_RECORDED}" \
    'real_mail_send=NOT_INVOKED' \
    'remote_mailbox_mutation=NOT_INVOKED' \
    'credential_values=NOT_RECORDED' \
    'response_bodies=NOT_RECORDED'
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

validate_base_url() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]*(\:[0-9]{1,5})?$ ]] \
    || fatal "$EX_CONFIG" "$label must be an HTTPS origin without a path, query or fragment"
}

validate_uuid() {
  local value="${1,,}"
  local label="$2"
  [[ "$value" =~ $UUID_PATTERN ]] || fatal "$EX_CONFIG" "$label must be a UUID"
}

validate_identifier() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
    || fatal "$EX_CONFIG" "$label is invalid"
}

if [[ "$FIXTURE_MODE" == skip ]]; then
  printf '%s\n' \
    'status=SKIP' \
    'reason=synthetic-mail-fixture-not-prepared' \
    'real_mail_send=NOT_INVOKED' \
    'remote_mailbox_mutation=NOT_INVOKED' \
    'credential_values=NOT_RECORDED' \
    'response_bodies=NOT_RECORDED'
  exit "$EX_SKIP"
fi
[[ "$FIXTURE_MODE" == required ]] \
  || fatal "$EX_CONFIG" 'NAV_MAIL_ACCEPTANCE_FIXTURE_MODE must be required or skip'

[[ "${NAV_ACCEPTANCE_EPHEMERAL:-}" == true ]] \
  || fatal "$EX_CONFIG" 'accept-mail-workspace.sh must be wrapped by nav-with-ephemeral-admin.sh'
require_env NAV_ACCEPTANCE_USERNAME_FILE "${NAV_ACCEPTANCE_USERNAME_FILE:-}"
require_env NAV_ACCEPTANCE_PASSWORD_FILE "${NAV_ACCEPTANCE_PASSWORD_FILE:-}"
require_env NAV_ACCEPTANCE_RUN_ID "${NAV_ACCEPTANCE_RUN_ID:-}"
require_env NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL "$PRIMARY_BASE_URL"
require_env NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL "$SECONDARY_BASE_URL"
require_env NAV_MAIL_ACCEPTANCE_MARKER "$MARKER"
require_env NAV_MAIL_ACCEPTANCE_ACCOUNT_ID "$ACCOUNT_ID"
require_env NAV_MAIL_ACCEPTANCE_FOLDER_ID "$FOLDER_ID"
require_env NAV_MAIL_ACCEPTANCE_MESSAGE_ID "$MESSAGE_ID"
require_env NAV_MAIL_ACCEPTANCE_DATABASE_CONTAINER "$DB_CONTAINER"
require_env NAV_MAIL_ACCEPTANCE_DATABASE_NAME "$DB_NAME"
require_env NAV_MAIL_ACCEPTANCE_DATABASE_USER "$DB_USER"

validate_base_url "$PRIMARY_BASE_URL" NAV_MAIL_ACCEPTANCE_PRIMARY_BASE_URL
validate_base_url "$SECONDARY_BASE_URL" NAV_MAIL_ACCEPTANCE_SECONDARY_BASE_URL
[[ "$NAV_ACCEPTANCE_RUN_ID" =~ ^[0-9a-f]{48}$ ]] \
  || fatal "$EX_CONFIG" 'NAV_ACCEPTANCE_RUN_ID must be a 48-character lowercase hexadecimal value'
[[ "$PRIMARY_BASE_URL" != "$SECONDARY_BASE_URL" ]] \
  || fatal "$EX_CONFIG" 'primary and secondary origins must be different'
ACCOUNT_ID="${ACCOUNT_ID,,}"
FOLDER_ID="${FOLDER_ID,,}"
MESSAGE_ID="${MESSAGE_ID,,}"
validate_uuid "$ACCOUNT_ID" NAV_MAIL_ACCEPTANCE_ACCOUNT_ID
validate_uuid "$FOLDER_ID" NAV_MAIL_ACCEPTANCE_FOLDER_ID
validate_uuid "$MESSAGE_ID" NAV_MAIL_ACCEPTANCE_MESSAGE_ID
[[ "$MARKER" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$ ]] \
  || fatal "$EX_CONFIG" 'NAV_MAIL_ACCEPTANCE_MARKER must be 8 to 120 URL-safe ASCII characters'
[[ "$DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
  || fatal "$EX_CONFIG" 'NAV_MAIL_ACCEPTANCE_DATABASE_CONTAINER is invalid'
validate_identifier "$DB_NAME" NAV_MAIL_ACCEPTANCE_DATABASE_NAME
validate_identifier "$DB_USER" NAV_MAIL_ACCEPTANCE_DATABASE_USER
[[ "$HTTP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  || fatal "$EX_CONFIG" 'NAV_MAIL_ACCEPTANCE_HTTP_TIMEOUT_SECONDS must be an integer'
(( HTTP_TIMEOUT_SECONDS >= 5 && HTTP_TIMEOUT_SECONDS <= 120 )) \
  || fatal "$EX_CONFIG" 'HTTP timeout must be between 5 and 120 seconds'

for dependency in curl jq mktemp chmod rm docker date; do
  command -v "$dependency" >/dev/null 2>&1 \
    || fatal "$EX_CONFIG" "required command is unavailable: $dependency"
done

for credential_file in "$NAV_ACCEPTANCE_USERNAME_FILE" "$NAV_ACCEPTANCE_PASSWORD_FILE"; do
  [[ "$credential_file" == /* && -f "$credential_file" && ! -L "$credential_file" && -s "$credential_file" ]] \
    || fatal "$EX_CONFIG" 'ephemeral credential file is missing or unsafe'
done

TMP_DIR="$(mktemp -d /run/nav-mail-acceptance.XXXXXX)"
chmod 0700 "$TMP_DIR"
PRIMARY_COOKIE_JAR="$TMP_DIR/primary.cookies"
SECONDARY_COOKIE_JAR="$TMP_DIR/secondary.cookies"
: > "$PRIMARY_COOKIE_JAR"
: > "$SECONDARY_COOKIE_JAR"
chmod 0600 "$PRIMARY_COOKIE_JAR" "$SECONDARY_COOKIE_JAR"

request_json() {
  local label="$1"
  local method="$2"
  local base_url="$3"
  local path="$4"
  local cookie_jar="$5"
  local body_file="$6"
  local response_file="$7"
  local expected_codes="$8"
  local status_file="$TMP_DIR/http-status"
  local -a args=(
    --silent
    --show-error
    --proto '=https'
    --max-redirs 0
    --connect-timeout "$HTTP_TIMEOUT_SECONDS"
    --max-time "$HTTP_TIMEOUT_SECONDS"
    --request "$method"
    --header 'Accept: application/json'
    --header "Origin: $base_url"
    --header 'User-Agent: DOMO-NAV-mail-release-acceptance/1'
    --cookie "$cookie_jar"
    --cookie-jar "$cookie_jar"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$body_file" ]]; then
    [[ -f "$body_file" && ! -L "$body_file" ]] \
      || fatal "$EX_SOFTWARE" "$label request body is unavailable"
    args+=(--header 'Content-Type: application/json' --data-binary "@$body_file")
  fi
  if ! curl "${args[@]}" "$base_url$path" > "$status_file"; then
    fatal "$EX_SOFTWARE" "$label transport failed"
  fi
  local http_status
  http_status="$(<"$status_file")"
  [[ " $expected_codes " == *" $http_status "* ]] \
    || fatal "$EX_SOFTWARE" "$label returned unexpected HTTP status $http_status"
  jq -e . "$response_file" >/dev/null \
    || fatal "$EX_SOFTWARE" "$label did not return valid JSON"
}

database_scalar() {
  local sql="$1"
  local label="$2"
  local value
  if ! value="$(docker exec "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -At -c "$sql")"; then
    fatal "$EX_SOFTWARE" "$label database probe failed"
  fi
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  [[ -n "$value" ]] || fatal "$EX_SOFTWARE" "$label database probe returned no value"
  printf '%s' "$value"
}

outbox_count() {
  local user_id="$1"
  database_scalar \
    "SELECT COUNT(*)::bigint FROM mail_outbox WHERE user_id = '$user_id'::uuid;" \
    'mail_outbox count'
}

delete_draft_exact() {
  local draft_id="$1"
  local deleted
  if ! deleted="$(docker exec "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -At -c \
    "WITH deleted AS (DELETE FROM email_drafts WHERE id = '$draft_id'::uuid AND user_id = '$EPHEMERAL_USER_ID'::uuid AND status = 'draft' AND outbox_id IS NULL RETURNING id) SELECT COUNT(*)::integer FROM deleted;")"; then
    return 1
  fi
  deleted="${deleted//$'\r'/}"
  deleted="${deleted//$'\n'/}"
  [[ "$deleted" == 1 ]] || return 1
  CREATED_DRAFT_ID=''
}

cleanup_json_request() {
  local method="$1"
  local base_url="$2"
  local path="$3"
  local cookie_jar="$4"
  local response_file="$5"
  local status
  status="$(curl \
    --silent \
    --show-error \
    --proto '=https' \
    --max-redirs 0 \
    --connect-timeout "$HTTP_TIMEOUT_SECONDS" \
    --max-time "$HTTP_TIMEOUT_SECONDS" \
    --request "$method" \
    --header 'Accept: application/json' \
    --header "Origin: $base_url" \
    --header 'User-Agent: DOMO-NAV-mail-release-acceptance/1' \
    --cookie "$cookie_jar" \
    --cookie-jar "$cookie_jar" \
    --output "$response_file" \
    --write-out '%{http_code}' \
    "$base_url$path")" || return 1
  [[ "$status" == 200 ]] || return 1
  jq -e . "$response_file" >/dev/null
}

delete_rule_api() {
  local response="$TMP_DIR/rule-cleanup.json"
  request_json 'notification rule cleanup' DELETE "$PRIMARY_BASE_URL" \
    "/api/email/notification-rules/$CREATED_RULE_ID" "$PRIMARY_COOKIE_JAR" '' "$response" '200'
  jq -e --arg id "$CREATED_RULE_ID" '.deleted == true and .id == $id' "$response" >/dev/null \
    || return 1
  CREATED_RULE_ID=''
}

delete_rule_best_effort() {
  local response="$TMP_DIR/rule-finalize.json"
  cleanup_json_request DELETE "$PRIMARY_BASE_URL" \
    "/api/email/notification-rules/$CREATED_RULE_ID" "$PRIMARY_COOKIE_JAR" "$response" \
    || return 1
  jq -e --arg id "$CREATED_RULE_ID" '.deleted == true and .id == $id' "$response" >/dev/null \
    || return 1
  CREATED_RULE_ID=''
}

logout_domain() {
  local label="$1"
  local base_url="$2"
  local cookie_jar="$3"
  local response="$TMP_DIR/logout-$label.json"
  request_json "$label logout" POST "$base_url" '/api/auth/logout' "$cookie_jar" '' "$response" '200'
  jq -e '.ok == true' "$response" >/dev/null
}

logout_best_effort() {
  local label="$1"
  local base_url="$2"
  local cookie_jar="$3"
  local response="$TMP_DIR/logout-finalize-$label.json"
  cleanup_json_request POST "$base_url" '/api/auth/logout' "$cookie_jar" "$response" \
    && jq -e '.ok == true' "$response" >/dev/null
}

finalize() {
  local original_status="$?"
  local cleanup_status=PASS
  local final_status="$original_status"
  "$FINALIZING" && exit "$original_status"
  FINALIZING=true
  trap - EXIT
  set +e

  if [[ -n "$CREATED_DRAFT_ID" && -n "$EPHEMERAL_USER_ID" ]]; then
    delete_draft_exact "$CREATED_DRAFT_ID" || cleanup_status=FAIL
  fi
  if [[ -n "$CREATED_RULE_ID" && "$PRIMARY_LOGGED_IN" == true ]]; then
    delete_rule_best_effort || cleanup_status=FAIL
  fi
  if "$SECONDARY_LOGGED_IN"; then
    logout_best_effort secondary "$SECONDARY_BASE_URL" "$SECONDARY_COOKIE_JAR" || cleanup_status=FAIL
  fi
  if "$PRIMARY_LOGGED_IN"; then
    logout_best_effort primary "$PRIMARY_BASE_URL" "$PRIMARY_COOKIE_JAR" || cleanup_status=FAIL
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" && ! -L "$TMP_DIR" && "$TMP_DIR" == /run/nav-mail-acceptance.* ]]; then
    rm -rf -- "$TMP_DIR" || cleanup_status=FAIL
  else
    cleanup_status=FAIL
  fi

  if [[ "$cleanup_status" != PASS ]]; then
    final_status="$EX_SOFTWARE"
    log 'acceptance cleanup failed'
  fi
  if ((original_status == 0 && final_status == 0)); then
    safe_summary PASS "$cleanup_status"
  else
    safe_summary FAIL "$cleanup_status"
  fi
  exit "$final_status"
}
trap finalize EXIT

login_payload="$TMP_DIR/login.json"
jq -n \
  --rawfile username "$NAV_ACCEPTANCE_USERNAME_FILE" \
  --rawfile password "$NAV_ACCEPTANCE_PASSWORD_FILE" \
  '{username: ($username | gsub("[\\r\\n]+$"; "")), password: ($password | gsub("[\\r\\n]+$"; ""))}' \
  > "$login_payload"
chmod 0600 "$login_payload"

login_primary_response="$TMP_DIR/login-primary.json"
request_json 'primary login' POST "$PRIMARY_BASE_URL" '/api/auth/login' \
  "$PRIMARY_COOKIE_JAR" "$login_payload" "$login_primary_response" '200'
EPHEMERAL_USER_ID="$(jq -r '.user.id // empty' "$login_primary_response")"
EPHEMERAL_USER_ID="${EPHEMERAL_USER_ID,,}"
validate_uuid "$EPHEMERAL_USER_ID" 'primary login user id'
jq -e --rawfile username "$NAV_ACCEPTANCE_USERNAME_FILE" \
  '.user.username == ($username | gsub("[\\r\\n]+$"; ""))' "$login_primary_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'primary login returned the wrong user'
PRIMARY_LOGGED_IN=true

primary_session_response="$TMP_DIR/session-primary.json"
request_json 'primary session' GET "$PRIMARY_BASE_URL" '/api/auth/session' \
  "$PRIMARY_COOKIE_JAR" '' "$primary_session_response" '200'
jq -e --arg user_id "$EPHEMERAL_USER_ID" '.user.id == $user_id' "$primary_session_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'primary session did not preserve the login'

login_secondary_response="$TMP_DIR/login-secondary.json"
request_json 'secondary login' POST "$SECONDARY_BASE_URL" '/api/auth/login' \
  "$SECONDARY_COOKIE_JAR" "$login_payload" "$login_secondary_response" '200'
jq -e --arg user_id "$EPHEMERAL_USER_ID" '.user.id == $user_id' "$login_secondary_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'secondary login returned a different user'
SECONDARY_LOGGED_IN=true

secondary_session_response="$TMP_DIR/session-secondary.json"
request_json 'secondary session' GET "$SECONDARY_BASE_URL" '/api/auth/session' \
  "$SECONDARY_COOKIE_JAR" '' "$secondary_session_response" '200'
jq -e --arg user_id "$EPHEMERAL_USER_ID" '.user.id == $user_id' "$secondary_session_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'secondary session did not preserve the login'

rm -f -- "$login_payload" "$login_primary_response" "$login_secondary_response"

OUTBOX_BEFORE="$(outbox_count "$EPHEMERAL_USER_ID")"
[[ "$OUTBOX_BEFORE" =~ ^[0-9]+$ ]] \
  || fatal "$EX_SOFTWARE" 'mail_outbox before count is invalid'

encoded_marker="$(jq -rn --arg value "$MARKER" '$value | @uri')"
list_response="$TMP_DIR/list.json"
request_json 'synthetic mailbox list' GET "$PRIMARY_BASE_URL" \
  "/api/email/accounts/$ACCOUNT_ID/messages?folderId=$FOLDER_ID&limit=50" \
  "$PRIMARY_COOKIE_JAR" '' "$list_response" '200'
jq -e '.messages | type == "array"' "$list_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'mailbox list contract is invalid'

search_response="$TMP_DIR/search.json"
request_json 'server mailbox search' GET "$PRIMARY_BASE_URL" \
  "/api/email/accounts/$ACCOUNT_ID/messages?folderId=$FOLDER_ID&limit=50&filter=all&q=$encoded_marker" \
  "$PRIMARY_COOKIE_JAR" '' "$search_response" '200'
jq -e --arg id "$MESSAGE_ID" --arg marker "$MARKER" '
  .search.query == $marker
  and .search.filter == "all"
  and any(.messages[]; .canonicalMessageId == $id)
' "$search_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'server mailbox search did not find the prepared synthetic message'
LOCATION_ID="$(jq -r --arg id "$MESSAGE_ID" \
  'first(.messages[] | select(.canonicalMessageId == $id) | .locationId) // empty' "$search_response")"
LOCATION_ID="${LOCATION_ID,,}"
validate_uuid "$LOCATION_ID" 'prepared synthetic location id'

filter_response="$TMP_DIR/filter.json"
request_json 'server mailbox unread filter' GET "$SECONDARY_BASE_URL" \
  "/api/email/accounts/$ACCOUNT_ID/messages?folderId=$FOLDER_ID&limit=20&filter=unread" \
  "$SECONDARY_COOKIE_JAR" '' "$filter_response" '200'
jq -e '.messages | type == "array"' "$filter_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'mailbox filter response is invalid'
jq -e '.search.filter == "unread"' "$filter_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'server mailbox filter was not applied'

detail_response="$TMP_DIR/detail.json"
request_json 'synthetic mailbox detail' GET "$SECONDARY_BASE_URL" \
  "/api/email/accounts/$ACCOUNT_ID/messages/$LOCATION_ID?folderId=$FOLDER_ID" \
  "$SECONDARY_COOKIE_JAR" '' "$detail_response" '200'
jq -e --arg id "$MESSAGE_ID" --arg marker "$MARKER" '
  .message.canonicalMessageId == $id
  and ((.message.subject + " " + .message.body) | contains($marker))
' "$detail_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'prepared synthetic message detail is inconsistent'
THREAD_KEY="$(jq -r '.message.threadKey // empty' "$detail_response")"
THREAD_KEY="${THREAD_KEY,,}"
[[ "$THREAD_KEY" =~ $SHA256_PATTERN ]] \
  || fatal "$EX_SOFTWARE" 'prepared synthetic message has no stable conversation key'

command_payload="$TMP_DIR/remote-command.json"
jq -e '
  (.message.remote.uidValidity | tostring | test("^[1-9][0-9]*$"))
  and ((.message.remote.modseq == null) or (.message.remote.modseq | tostring | test("^[1-9][0-9]*$")))
  and (.message.flags.seen | type == "boolean")
  and (.message.flags.flagged | type == "boolean")
  and (.message.flags.deleted | type == "boolean")
' "$detail_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'prepared synthetic message has no remote conflict snapshot'
jq -n \
  --arg key "accept:$NAV_ACCEPTANCE_RUN_ID" \
  --arg uid_validity "$(jq -r '.message.remote.uidValidity' "$detail_response")" \
  --arg modseq "$(jq -r '.message.remote.modseq // empty' "$detail_response")" \
  --argjson seen "$(jq '.message.flags.seen' "$detail_response")" \
  --argjson flagged "$(jq '.message.flags.flagged' "$detail_response")" \
  --argjson deleted "$(jq '.message.flags.deleted' "$detail_response")" '
  {
    action: (if $seen then "mark_unread" else "mark_read" end),
    idempotencyKey: $key,
    expected: {
      uidValidity: $uid_validity,
      modseq: (if $modseq == "" then null else $modseq end),
      seen: $seen,
      flagged: $flagged,
      deleted: $deleted
    }
  }
' > "$command_payload"

command_create_response="$TMP_DIR/remote-command-create.json"
request_json 'remote command enqueue' POST "$PRIMARY_BASE_URL" \
  "/api/email/accounts/$ACCOUNT_ID/messages/$LOCATION_ID/commands" \
  "$PRIMARY_COOKIE_JAR" "$command_payload" "$command_create_response" '202'
REMOTE_COMMAND_ID="$(jq -r '.command.id // empty' "$command_create_response")"
REMOTE_COMMAND_ID="${REMOTE_COMMAND_ID,,}"
validate_uuid "$REMOTE_COMMAND_ID" 'remote command id'
jq -e --arg id "$REMOTE_COMMAND_ID" '
  .idempotentReplay == false
  and .command.id == $id
  and .command.status == "scheduled"
  and (.command.undoUntil | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
' "$command_create_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'remote command enqueue contract is invalid'

command_replay_response="$TMP_DIR/remote-command-replay.json"
request_json 'remote command idempotent replay' POST "$SECONDARY_BASE_URL" \
  "/api/email/accounts/$ACCOUNT_ID/messages/$LOCATION_ID/commands" \
  "$SECONDARY_COOKIE_JAR" "$command_payload" "$command_replay_response" '202'
jq -e --arg id "$REMOTE_COMMAND_ID" '
  .idempotentReplay == true and .command.id == $id and .command.status == "scheduled"
' "$command_replay_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'remote command idempotent replay contract is invalid'

empty_payload="$TMP_DIR/empty.json"
printf '%s\n' '{}' > "$empty_payload"
command_undo_response="$TMP_DIR/remote-command-undo.json"
request_json 'remote command undo' POST "$SECONDARY_BASE_URL" \
  "/api/email/commands/$REMOTE_COMMAND_ID/undo" "$SECONDARY_COOKIE_JAR" \
  "$empty_payload" "$command_undo_response" '200'
jq -e --arg id "$REMOTE_COMMAND_ID" '.command.id == $id and .command.status == "cancelled"' \
  "$command_undo_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'remote command undo contract is invalid'

command_status_response="$TMP_DIR/remote-command-status.json"
request_json 'remote command final status' GET "$PRIMARY_BASE_URL" \
  "/api/email/commands/$REMOTE_COMMAND_ID" "$PRIMARY_COOKIE_JAR" '' \
  "$command_status_response" '200'
jq -e --arg id "$REMOTE_COMMAND_ID" '.command.id == $id and .command.status == "cancelled"' \
  "$command_status_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'cancelled remote command was not visible through the primary domain'
REMOTE_COMMAND_QUEUE='PASS'

existing_rules_response="$TMP_DIR/rules-before.json"
request_json 'notification rules preflight' GET "$PRIMARY_BASE_URL" \
  "/api/email/notification-rules?accountId=$ACCOUNT_ID" \
  "$PRIMARY_COOKIE_JAR" '' "$existing_rules_response" '200'
jq -e --arg thread "$THREAD_KEY" '
  (.rules | type == "array") and (all(.rules[]; .scope != "conversation" or .matchValue != $thread))
' "$existing_rules_response" >/dev/null \
  || fatal "$EX_CONFIG" 'prepared fixture already has a notification rule for this conversation'

rule_payload="$TMP_DIR/rule.json"
jq -n --arg account "$ACCOUNT_ID" --arg thread "$THREAD_KEY" '{
  accountId: $account,
  scope: "conversation",
  matchValue: $thread,
  action: "immediate",
  enabled: true,
  expiresAt: null,
  criticalOverrideConfirmed: false
}' > "$rule_payload"

rule_preview_response="$TMP_DIR/rule-preview.json"
request_json 'notification rule preview' POST "$PRIMARY_BASE_URL" \
  '/api/email/notification-rules/preview' "$PRIMARY_COOKIE_JAR" \
  "$rule_payload" "$rule_preview_response" '200'
jq -e --arg account "$ACCOUNT_ID" --arg thread "$THREAD_KEY" '
  .normalized.accountId == $account
  and .normalized.scope == "conversation"
  and .normalized.matchValue == $thread
  and .normalized.action == "immediate"
  and (.matchCount | type == "number")
' "$rule_preview_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'notification rule preview contract is invalid'

rule_create_response="$TMP_DIR/rule-create.json"
request_json 'notification rule create' POST "$PRIMARY_BASE_URL" \
  '/api/email/notification-rules' "$PRIMARY_COOKIE_JAR" \
  "$rule_payload" "$rule_create_response" '201'
CREATED_RULE_ID="$(jq -r '.rule.id // empty' "$rule_create_response")"
CREATED_RULE_ID="${CREATED_RULE_ID,,}"
validate_uuid "$CREATED_RULE_ID" 'created notification rule id'
jq -e --arg id "$CREATED_RULE_ID" '.created == true and .rule.id == $id' "$rule_create_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'notification rule was not newly created'

rules_list_response="$TMP_DIR/rules-list.json"
request_json 'notification rule list' GET "$SECONDARY_BASE_URL" \
  "/api/email/notification-rules?accountId=$ACCOUNT_ID" \
  "$SECONDARY_COOKIE_JAR" '' "$rules_list_response" '200'
jq -e --arg id "$CREATED_RULE_ID" 'any(.rules[]; .id == $id and .enabled == true)' \
  "$rules_list_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'notification rule was not visible through the secondary domain'

rule_patch_payload="$TMP_DIR/rule-patch.json"
jq -n '{enabled: false}' > "$rule_patch_payload"
rule_patch_response="$TMP_DIR/rule-patch-response.json"
request_json 'notification rule patch' PATCH "$PRIMARY_BASE_URL" \
  "/api/email/notification-rules/$CREATED_RULE_ID" "$PRIMARY_COOKIE_JAR" \
  "$rule_patch_payload" "$rule_patch_response" '200'
jq -e --arg id "$CREATED_RULE_ID" '.rule.id == $id and .rule.enabled == false' \
  "$rule_patch_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'notification rule patch did not persist'

delete_rule_api \
  || fatal "$EX_SOFTWARE" 'notification rule cleanup did not delete the exact rule'

ai_summary_payload="$TMP_DIR/ai-summary.json"
jq -n '{action: "summarize"}' > "$ai_summary_payload"
ai_summary_response="$TMP_DIR/ai-summary-response.json"
request_json 'email AI summarize' POST "$PRIMARY_BASE_URL" \
  "/api/email/messages/$MESSAGE_ID/ai" "$PRIMARY_COOKIE_JAR" \
  "$ai_summary_payload" "$ai_summary_response" '200'
jq -e --arg id "$MESSAGE_ID" '
  (.result.text | type == "string" and length > 0)
  and any(.sources[]; .messageId == $id)
  and (.resourceVersion | test("^[0-9a-f]{64}$"))
' "$ai_summary_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'email AI summarize contract is invalid'

ai_search_payload="$TMP_DIR/ai-search.json"
jq -n --arg marker "$MARKER" '{search: $marker, question: $marker, answer: false}' > "$ai_search_payload"
ai_search_response="$TMP_DIR/ai-search-response.json"
request_json 'cross-mail AI source search' POST "$SECONDARY_BASE_URL" \
  '/api/email/ai/search' "$SECONDARY_COOKIE_JAR" \
  "$ai_search_payload" "$ai_search_response" '200'
jq -e --arg id "$MESSAGE_ID" '
  .result == null and any(.sources[]; .messageId == $id and (.sourceId | type == "string"))
' "$ai_search_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'cross-mail AI search did not return the prepared source'

proposal_payload="$TMP_DIR/proposal.json"
jq -n --arg marker "$MARKER" '{
  kind: "create_draft",
  instruction: ("生成只用于发布验收的简短回复草稿：" + $marker),
  tone: "professional",
  length: "short"
}' > "$proposal_payload"
proposal_response="$TMP_DIR/proposal-response.json"
request_json 'email AI encrypted draft proposal' POST "$PRIMARY_BASE_URL" \
  "/api/email/messages/$MESSAGE_ID/ai/proposals" "$PRIMARY_COOKIE_JAR" \
  "$proposal_payload" "$proposal_response" '200'
jq -e --arg account "$ACCOUNT_ID" --arg message "$MESSAGE_ID" '
  .proposal.kind == "create_draft"
  and .proposal.params.accountId == $account
  and .proposal.params.sourceMessageId == $message
  and (.proposal.params.text | type == "string" and length > 0)
  and (.proposal.operationId | test("^[0-9a-f-]{36}$"))
  and (.proposal.confirmationToken | type == "string" and length > 40)
  and .proposal.previewRequired == true
  and .proposal.autoExecuted == false
' "$proposal_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'encrypted draft proposal contract is invalid'

confirm_payload="$TMP_DIR/confirm.json"
jq '.proposal | {kind, params, operationId, confirmationToken}' "$proposal_response" > "$confirm_payload"
confirm_response="$TMP_DIR/confirm-response.json"
request_json 'email AI encrypted draft confirmation' POST "$PRIMARY_BASE_URL" \
  "/api/email/messages/$MESSAGE_ID/ai/confirm" "$PRIMARY_COOKIE_JAR" \
  "$confirm_payload" "$confirm_response" '201'
CREATED_DRAFT_ID="$(jq -r '.receipt.resourceId // empty' "$confirm_response")"
CREATED_DRAFT_ID="${CREATED_DRAFT_ID,,}"
validate_uuid "$CREATED_DRAFT_ID" 'created encrypted draft id'
jq -e --arg id "$CREATED_DRAFT_ID" '
  .receipt.resourceType == "email_draft"
  and .receipt.resourceId == $id
  and .receipt.status == "succeeded"
  and .receipt.summary.created == true
  and .receipt.replayed == false
  and .result.draft.id == $id
' "$confirm_response" >/dev/null \
  || fatal "$EX_SOFTWARE" 'encrypted draft confirmation contract is invalid'

encrypted_draft_count="$(database_scalar \
  "SELECT COUNT(*)::integer FROM email_drafts WHERE id = '$CREATED_DRAFT_ID'::uuid AND user_id = '$EPHEMERAL_USER_ID'::uuid AND status = 'draft' AND outbox_id IS NULL AND payload_encrypted IS NOT NULL AND octet_length(payload_encrypted) >= 32 AND content_hash ~ '^[0-9a-f]{64}$';" \
  'encrypted draft persistence')"
[[ "$encrypted_draft_count" == 1 ]] \
  || fatal "$EX_SOFTWARE" 'confirmed draft is not stored as a bounded encrypted payload'

delete_draft_exact "$CREATED_DRAFT_ID" \
  || fatal "$EX_SOFTWARE" 'encrypted draft cleanup did not delete the exact draft'

OUTBOX_AFTER="$(outbox_count "$EPHEMERAL_USER_ID")"
[[ "$OUTBOX_AFTER" =~ ^[0-9]+$ ]] \
  || fatal "$EX_SOFTWARE" 'mail_outbox after count is invalid'
[[ "$OUTBOX_AFTER" == "$OUTBOX_BEFORE" ]] \
  || fatal "$EX_SOFTWARE" 'mail_outbox changed even though mail sending was outside acceptance scope'

logout_domain secondary "$SECONDARY_BASE_URL" "$SECONDARY_COOKIE_JAR" \
  || fatal "$EX_SOFTWARE" 'secondary logout failed'
SECONDARY_LOGGED_IN=false
logout_domain primary "$PRIMARY_BASE_URL" "$PRIMARY_COOKIE_JAR" \
  || fatal "$EX_SOFTWARE" 'primary logout failed'
PRIMARY_LOGGED_IN=false

safe_summary PASS PASS
