#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
export LC_ALL=C

readonly EX_SOFTWARE=70
readonly EX_CONFIG=78
readonly DEFAULT_MAX_ROWS=100000
readonly DEFAULT_MAX_RELATION_BYTES=268435456
readonly DEFAULT_MAX_REHEARSAL_SECONDS=120

fatal() {
  printf 'NO-GO: %s\n' "$2" >&2
  exit "$1"
}

require_safe_argument() {
  local label="$1"
  local value="$2"
  [[ -n "$value" && ${#value} -le 128 && "$value" =~ ^[A-Za-z0-9_.-]+$ ]] \
    || fatal "$EX_CONFIG" "$label is missing or contains unsafe characters"
}

require_positive_integer() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]] \
    || fatal "$EX_CONFIG" "$label must be a positive integer"
}

require_nonnegative_integer() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] \
    || fatal "$EX_CONFIG" "$label must be a non-negative integer"
}

mode="${1:-}"
case "$mode" in
  --preflight)
    container="${NAV_EMAIL_039_DATABASE_CONTAINER:-}"
    database="${NAV_EMAIL_039_DATABASE_NAME:-}"
    database_user="${NAV_EMAIL_039_DATABASE_USER:-}"
    max_rows="${NAV_EMAIL_039_MAX_EVENT_ROWS:-$DEFAULT_MAX_ROWS}"
    max_bytes="${NAV_EMAIL_039_MAX_RELATION_BYTES:-$DEFAULT_MAX_RELATION_BYTES}"

    require_safe_argument 'NAV_EMAIL_039_DATABASE_CONTAINER' "$container"
    require_safe_argument 'NAV_EMAIL_039_DATABASE_NAME' "$database"
    require_safe_argument 'NAV_EMAIL_039_DATABASE_USER' "$database_user"
    require_positive_integer 'NAV_EMAIL_039_MAX_EVENT_ROWS' "$max_rows"
    require_positive_integer 'NAV_EMAIL_039_MAX_RELATION_BYTES' "$max_bytes"

    metrics="$({
      docker exec "$container" psql \
        -XqAt -F '|' -v ON_ERROR_STOP=1 \
        -U "$database_user" -d "$database" \
        -c "SET lock_timeout = '2s'; SET statement_timeout = '15s'; SELECT COUNT(*)::bigint, pg_total_relation_size('public.email_events'::regclass)::bigint FROM public.email_events;"
    } 2>&1)" || fatal "$EX_SOFTWARE" "bounded read-only email_events preflight failed: $metrics"

    metrics="$(printf '%s\n' "$metrics" | tail -n 1)"
    IFS='|' read -r event_rows relation_bytes extra <<< "$metrics"
    [[ -z "${extra:-}" ]] || fatal "$EX_SOFTWARE" 'preflight returned an unexpected result shape'
    require_nonnegative_integer 'email_events row count' "$event_rows"
    require_positive_integer 'email_events relation size' "$relation_bytes"
    (( event_rows <= max_rows )) \
      || fatal "$EX_SOFTWARE" "email_events has $event_rows rows; limit is $max_rows"
    (( relation_bytes <= max_bytes )) \
      || fatal "$EX_SOFTWARE" "email_events relation is $relation_bytes bytes; limit is $max_bytes"
    printf 'GO: email_events_rows=%s relation_bytes=%s row_limit=%s byte_limit=%s\n' \
      "$event_rows" "$relation_bytes" "$max_rows" "$max_bytes"
    ;;
  --check-rehearsal-seconds)
    elapsed_seconds="${2:-}"
    max_seconds="${NAV_EMAIL_039_MAX_REHEARSAL_SECONDS:-$DEFAULT_MAX_REHEARSAL_SECONDS}"
    require_positive_integer 'isolated migration elapsed seconds' "$elapsed_seconds"
    require_positive_integer 'NAV_EMAIL_039_MAX_REHEARSAL_SECONDS' "$max_seconds"
    (( elapsed_seconds <= max_seconds )) \
      || fatal "$EX_SOFTWARE" "isolated migration took ${elapsed_seconds}s; limit is ${max_seconds}s"
    printf 'GO: isolated_migration_seconds=%s time_limit_seconds=%s\n' \
      "$elapsed_seconds" "$max_seconds"
    ;;
  *)
    printf '%s\n' \
      'Usage:' \
      '  check-email-notification-migration.sh --preflight' \
      '  check-email-notification-migration.sh --check-rehearsal-seconds SECONDS' >&2
    exit "$EX_CONFIG"
    ;;
esac
