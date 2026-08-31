#!/usr/bin/env bash
set -Eeuo pipefail

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_IOERR=74
readonly EX_TEMPFAIL=75
readonly EX_CONFIG=78
readonly EX_MISMATCH=80

umask 077

MODE=""
OUTPUT=""
EXPECTED=""
POSTGRES_CONTAINER=""
DATABASE="nav"
DATABASE_USER="nav"
DOCKER_BIN="${NAV_RELEASE_GUARD_DOCKER_BIN:-docker}"

fatal() {
  local code="$1"
  shift
  printf 'nav-release-mail-backlog-guard: %s\n' "$*" >&2
  exit "$code"
}

usage() {
  cat <<'EOF'
Usage:
  nav-release-mail-backlog-guard.sh snapshot --container NAME --output ABSOLUTE_PATH [--database NAME] [--user NAME]
  nav-release-mail-backlog-guard.sh verify   --container NAME --expected ABSOLUTE_PATH [--database NAME] [--user NAME]

The snapshot binds the complete email classification backlog identity and
lifecycle state. Verification fails if any row is added, removed, reordered or
changed. It never updates PostgreSQL or a container.
EOF
}

require_safe_name() {
  local value="$1" label="$2"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] \
    || fatal "$EX_CONFIG" "$label is invalid"
}

require_absolute_regular_file() {
  local path="$1" label="$2"
  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "$label must be an absolute path"
  [[ -f "$path" && ! -L "$path" ]] || fatal "$EX_CONFIG" "$label must be a regular non-symlink file"
}

while (($#)); do
  case "$1" in
    snapshot|verify)
      [[ -z "$MODE" ]] || fatal "$EX_USAGE" 'mode may be supplied only once'
      MODE="$1"
      shift
      ;;
    --container)
      (($# >= 2)) || fatal "$EX_USAGE" '--container requires a value'
      POSTGRES_CONTAINER="$2"
      shift 2
      ;;
    --output)
      (($# >= 2)) || fatal "$EX_USAGE" '--output requires a value'
      OUTPUT="$2"
      shift 2
      ;;
    --expected)
      (($# >= 2)) || fatal "$EX_USAGE" '--expected requires a value'
      EXPECTED="$2"
      shift 2
      ;;
    --database)
      (($# >= 2)) || fatal "$EX_USAGE" '--database requires a value'
      DATABASE="$2"
      shift 2
      ;;
    --user)
      (($# >= 2)) || fatal "$EX_USAGE" '--user requires a value'
      DATABASE_USER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fatal "$EX_USAGE" "unsupported argument: $1" ;;
  esac
done

[[ "$MODE" == snapshot || "$MODE" == verify ]] || fatal "$EX_USAGE" 'snapshot or verify mode is required'
require_safe_name "$POSTGRES_CONTAINER" 'container name'
require_safe_name "$DATABASE" 'database name'
require_safe_name "$DATABASE_USER" 'database user'

if [[ "$DOCKER_BIN" == */* ]]; then
  [[ "$DOCKER_BIN" == /* && -x "$DOCKER_BIN" ]] || fatal "$EX_CONFIG" 'configured docker binary must be an absolute executable path'
else
  DOCKER_BIN="$(command -v "$DOCKER_BIN" || true)"
  [[ -n "$DOCKER_BIN" ]] || fatal "$EX_UNAVAILABLE" 'docker is unavailable'
fi

readonly SNAPSHOT_SQL="COPY (
  SELECT
    id::text,
    user_id::text,
    account_id::text,
    email_message_id::text,
    status::text,
    attempt_count::text,
    max_attempts::text,
    notification_eligible::text,
    to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
    COALESCE(to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), ''),
    COALESCE(to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), ''),
    COALESCE(to_char(last_error_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), ''),
    COALESCE(last_error_code, ''),
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')
  FROM email_classification_jobs
  ORDER BY id
) TO STDOUT WITH (FORMAT csv, HEADER true, FORCE_QUOTE *);"

snapshot_to() {
  local target="$1"
  "$DOCKER_BIN" exec -i "$POSTGRES_CONTAINER" \
    psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet \
    --username "$DATABASE_USER" --dbname "$DATABASE" \
    --command "$SNAPSHOT_SQL" >"$target" \
    || fatal "$EX_UNAVAILABLE" 'PostgreSQL backlog snapshot failed'
  [[ -s "$target" ]] || fatal "$EX_IOERR" 'PostgreSQL backlog snapshot is empty'
  local header
  IFS= read -r header <"$target"
  [[ "$header" == 'id,user_id,account_id,email_message_id,status,attempt_count,max_attempts,notification_eligible,next_attempt_at,started_at,completed_at,last_error_at,last_error_code,created_at,updated_at' ]] \
    || fatal "$EX_MISMATCH" 'PostgreSQL backlog snapshot header is unexpected'
}

write_metadata() {
  local snapshot="$1"
  local hash row_count
  hash="$(sha256sum "$snapshot" | awk '{print $1}')"
  row_count="$(( $(wc -l <"$snapshot") - 1 ))"
  ((row_count >= 0)) || fatal "$EX_IOERR" 'snapshot row count is invalid'
  printf '%s  %s\n' "$hash" "$(basename "$snapshot")" >"${snapshot}.sha256"
  printf '%s\n' "$row_count" >"${snapshot}.count"
}

verify_metadata() {
  local snapshot="$1"
  require_absolute_regular_file "${snapshot}.sha256" 'snapshot checksum sidecar'
  require_absolute_regular_file "${snapshot}.count" 'snapshot count sidecar'
  (
    cd "$(dirname "$snapshot")"
    sha256sum --check --status "$(basename "$snapshot").sha256"
  ) || fatal "$EX_MISMATCH" 'expected backlog snapshot checksum does not match'
  local expected_count actual_count
  expected_count="$(<"${snapshot}.count")"
  [[ "$expected_count" =~ ^[0-9]+$ ]] || fatal "$EX_CONFIG" 'expected backlog count is invalid'
  actual_count="$(( $(wc -l <"$snapshot") - 1 ))"
  [[ "$actual_count" == "$expected_count" ]] || fatal "$EX_MISMATCH" 'expected backlog snapshot count does not match its sidecar'
}

if [[ "$MODE" == snapshot ]]; then
  [[ -n "$OUTPUT" && -z "$EXPECTED" ]] || fatal "$EX_USAGE" 'snapshot requires only --output'
  [[ "$OUTPUT" == /* ]] || fatal "$EX_CONFIG" 'output must be an absolute path'
  [[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || fatal "$EX_CONFIG" 'output already exists'
  output_parent="$(dirname "$OUTPUT")"
  [[ -d "$output_parent" && ! -L "$output_parent" ]] || fatal "$EX_CONFIG" 'output parent must be an existing non-symlink directory'
  temporary="$(mktemp "${output_parent}/.nav-mail-backlog.XXXXXX")" \
    || fatal "$EX_IOERR" 'temporary snapshot could not be created'
  trap 'rm -f -- "$temporary"' EXIT
  snapshot_to "$temporary"
  mv -- "$temporary" "$OUTPUT"
  trap - EXIT
  write_metadata "$OUTPUT"
  printf 'BACKLOG_SNAPSHOT_STATUS=CAPTURED\n'
  printf 'BACKLOG_SNAPSHOT_ROWS=%s\n' "$(<"${OUTPUT}.count")"
  printf 'BACKLOG_SNAPSHOT_SHA256=%s\n' "$(awk '{print $1}' "${OUTPUT}.sha256")"
  exit 0
fi

[[ -n "$EXPECTED" && -z "$OUTPUT" ]] || fatal "$EX_USAGE" 'verify requires only --expected'
require_absolute_regular_file "$EXPECTED" 'expected backlog snapshot'
verify_metadata "$EXPECTED"
verify_parent="$(dirname "$EXPECTED")"
current="$(mktemp "${verify_parent}/.nav-mail-backlog-verify.XXXXXX")" \
  || fatal "$EX_IOERR" 'verification snapshot could not be created'
trap 'rm -f -- "$current"' EXIT
snapshot_to "$current"
if ! cmp --silent -- "$EXPECTED" "$current"; then
  expected_rows="$(<"${EXPECTED}.count")"
  current_rows="$(( $(wc -l <"$current") - 1 ))"
  fatal "$EX_TEMPFAIL" "backlog diverged (expected_rows=${expected_rows}, current_rows=${current_rows}); repeat preflight before switching"
fi
printf 'BACKLOG_SNAPSHOT_STATUS=MATCH\n'
printf 'BACKLOG_SNAPSHOT_ROWS=%s\n' "$(<"${EXPECTED}.count")"
printf 'BACKLOG_SNAPSHOT_SHA256=%s\n' "$(awk '{print $1}' "${EXPECTED}.sha256")"
