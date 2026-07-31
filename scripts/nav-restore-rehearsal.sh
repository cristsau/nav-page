#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_CANTCREAT=73
readonly EX_TEMPFAIL=75
readonly EX_CONFIG=78
readonly EX_VERIFY=80

PROGRAM_NAME="$(basename "$0")"
CONFIG_FILE="${NAV_BACKUP_CONFIG:-/etc/nav/nav-backup.env}"
BACKUP_DIR=""
CLI_DRY_RUN=false
RUN_ISOLATED=false
DRY_RUN=false
CURRENT_STAGE="initialization"
TEMP_DIR=""
REHEARSAL_CONTAINER=""
REPORT_FILE=""

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

report() {
  log "$*"
  if [[ -n "$REPORT_FILE" ]]; then
    printf '%s\t%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$REPORT_FILE"
  fi
}

usage() {
  cat <<'EOF'
Usage:
  nav-restore-rehearsal.sh --backup DIR [--config FILE] [--dry-run]
                           [--run-isolated]

Default mode verifies manifest.sha256 and runs pg_restore -l without restoring.
--run-isolated additionally requires NAV_ENABLE_RESTORE_CONTAINER=true and
restores into a temporary network-less PostgreSQL container.
EOF
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

require_uint() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fatal "$EX_CONFIG" "$name must be a non-negative integer"
}

assert_safe_settings_file() {
  local path="$1"
  local exact_mode="${2:-}"
  local mode owner

  [[ "$path" == /* ]] || fatal "$EX_CONFIG" "settings file path must be absolute: $path"
  [[ -f "$path" && ! -L "$path" ]] || fatal "$EX_CONFIG" "settings file must be a regular non-symlink file: $path"
  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  [[ "$owner" == "$EUID" ]] || fatal "$EX_CONFIG" "settings file must be owned by uid $EUID: $path"

  if [[ -n "$exact_mode" ]]; then
    [[ "$mode" == "$exact_mode" ]] || fatal "$EX_CONFIG" "settings file must have mode $exact_mode: $path"
  else
    (( (8#$mode & 022) == 0 )) || fatal "$EX_CONFIG" "settings file must not be group/world writable: $path"
  fi
}

read_telegram_credentials() {
  local path="$1"
  local line key value mode owner
  TELEGRAM_BOT_TOKEN_VALUE=""
  TELEGRAM_CHAT_ID_VALUE=""

  if [[ "$path" != /* || ! -f "$path" || -L "$path" ]]; then
    log "Telegram credential file must be an absolute regular non-symlink file"
    return 1
  fi
  mode="$(stat -c '%a' -- "$path" 2>/dev/null || true)"
  owner="$(stat -c '%u' -- "$path" 2>/dev/null || true)"
  if [[ "$mode" != "600" || "$owner" != "$EUID" ]]; then
    log "Telegram credential file must be owned by uid $EUID with mode 600"
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      log "invalid Telegram credential line"
      return 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      TELEGRAM_BOT_TOKEN) TELEGRAM_BOT_TOKEN_VALUE="$value" ;;
      TELEGRAM_CHAT_ID) TELEGRAM_CHAT_ID_VALUE="$value" ;;
      *)
        log "unsupported key in Telegram credential file: $key"
        return 1
        ;;
    esac
  done < "$path"

  [[ "$TELEGRAM_BOT_TOKEN_VALUE" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || return 1
  [[ "$TELEGRAM_CHAT_ID_VALUE" =~ ^-?[0-9]+$ ]] || return 1
}

send_failure_alert() {
  local exit_code="$1"
  local message="$2"
  local alert_text

  "$DRY_RUN" && return 0
  is_true "${NAV_ENABLE_TELEGRAM_ALERTS:-false}" || return 0
  command -v curl >/dev/null 2>&1 || { log "Telegram alert skipped: curl is unavailable"; return 0; }
  read_telegram_credentials "${NAV_TELEGRAM_CREDENTIAL_FILE:-}" \
    || { log "Telegram alert skipped: credential validation failed"; return 0; }

  alert_text="DOMO NAV restore rehearsal failed
host: $(hostname -f 2>/dev/null || hostname)
stage: $CURRENT_STAGE
exit: $exit_code
time: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
detail: $message"

  # The token is read by curl from its stdin-backed config and never appears
  # in the process command line.
  if ! curl --config - \
    --fail --silent --show-error \
    --max-time "${NAV_TELEGRAM_TIMEOUT_SECONDS:-10}" \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID_VALUE" \
    --data-urlencode "text=$alert_text" \
    >/dev/null <<EOF
url = "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_VALUE}/sendMessage"
EOF
  then
    log "Telegram alert delivery failed"
  fi
  TELEGRAM_BOT_TOKEN_VALUE=""
  TELEGRAM_CHAT_ID_VALUE=""
}

cleanup_container() {
  local rehearsal_label
  [[ -n "$REHEARSAL_CONTAINER" ]] || return 0
  if ! docker inspect "$REHEARSAL_CONTAINER" >/dev/null 2>&1; then
    REHEARSAL_CONTAINER=""
    return 0
  fi

  rehearsal_label="$(docker inspect --format '{{ index .Config.Labels "nav.restore-rehearsal" }}' \
    "$REHEARSAL_CONTAINER" 2>/dev/null || true)"
  if [[ "$rehearsal_label" != "true" ]]; then
    log "refused to remove a container without the rehearsal label: $REHEARSAL_CONTAINER"
    return 1
  fi

  docker rm -f -- "$REHEARSAL_CONTAINER" >/dev/null
  REHEARSAL_CONTAINER=""
}

cleanup_temp() {
  local temp_real parent_real
  [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]] || return 0
  temp_real="$(realpath -e -- "$TEMP_DIR" 2>/dev/null || true)"
  parent_real="$(realpath -e -- "$(dirname "$TEMP_DIR")" 2>/dev/null || true)"
  if [[ -n "$temp_real" && "$temp_real" == "$parent_real"/nav-restore-check.* ]]; then
    rm -rf -- "$temp_real"
  else
    log "refused to remove unverified temporary path: $TEMP_DIR"
  fi
  TEMP_DIR=""
}

fatal() {
  local exit_code="$1"
  shift
  local message="$*"

  trap - ERR
  report "ERROR: $message"
  send_failure_alert "$exit_code" "$message" || true
  cleanup_container || true
  cleanup_temp || true
  exit "$exit_code"
}

handle_error() {
  local original_code="$1"
  local line="$2"
  local mapped_code="$original_code"
  if (( mapped_code < 64 || mapped_code > 125 )); then
    mapped_code="$EX_SOFTWARE"
  fi
  fatal "$mapped_code" "unexpected command failure at line $line (original exit $original_code)"
}

trap 'handle_error "$?" "$LINENO"' ERR
trap 'cleanup_container || true; cleanup_temp || true' EXIT
trap 'fatal 130 "interrupted by signal"' INT TERM

while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      CONFIG_FILE="$2"
      shift 2
      ;;
    --backup)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      BACKUP_DIR="$2"
      shift 2
      ;;
    --dry-run)
      CLI_DRY_RUN=true
      shift
      ;;
    --run-isolated)
      RUN_ISOLATED=true
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

[[ -n "$BACKUP_DIR" ]] || { usage >&2; exit "$EX_USAGE"; }
assert_safe_settings_file "$CONFIG_FILE"
# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${NAV_BACKUP_ROOT:=/var/backups/nav}"
: "${NAV_RESTORE_LOCK_FILE:=/run/lock/nav-restore-rehearsal.lock}"
: "${NAV_REHEARSAL_REPORT_DIR:=/var/backups/nav-rehearsal-reports}"
: "${NAV_DB_CONTAINER:=nav-postgres}"
: "${NAV_ENABLE_RESTORE_CONTAINER:=false}"
: "${NAV_RESTORE_POSTGRES_IMAGE:=postgres:16-alpine}"
: "${NAV_RESTORE_TMPFS_SIZE:=1g}"
: "${NAV_RESTORE_READY_ATTEMPTS:=30}"
: "${NAV_RESTORE_READY_INTERVAL_SECONDS:=2}"
: "${NAV_ENABLE_TELEGRAM_ALERTS:=false}"
: "${NAV_TELEGRAM_CREDENTIAL_FILE:=/etc/nav/backup-telegram.env}"
: "${NAV_TELEGRAM_TIMEOUT_SECONDS:=10}"
: "${NAV_DRY_RUN:=false}"

if is_true "$NAV_DRY_RUN" || "$CLI_DRY_RUN"; then
  DRY_RUN=true
else
  DRY_RUN=false
fi

[[ "$NAV_BACKUP_ROOT" == /* ]] || fatal "$EX_CONFIG" "NAV_BACKUP_ROOT must be absolute"
[[ "$NAV_RESTORE_LOCK_FILE" == /* ]] || fatal "$EX_CONFIG" "NAV_RESTORE_LOCK_FILE must be absolute"
[[ "$NAV_REHEARSAL_REPORT_DIR" == /* ]] || fatal "$EX_CONFIG" "NAV_REHEARSAL_REPORT_DIR must be absolute"
[[ "$NAV_DB_CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fatal "$EX_CONFIG" "invalid NAV_DB_CONTAINER"
[[ "$NAV_RESTORE_POSTGRES_IMAGE" =~ ^[A-Za-z0-9][A-Za-z0-9_./:@-]*$ ]] \
  || fatal "$EX_CONFIG" "invalid NAV_RESTORE_POSTGRES_IMAGE"
[[ "$NAV_RESTORE_TMPFS_SIZE" =~ ^[1-9][0-9]*[mMgG]$ ]] \
  || fatal "$EX_CONFIG" "NAV_RESTORE_TMPFS_SIZE must look like 512m or 1g"
require_uint NAV_RESTORE_READY_ATTEMPTS "$NAV_RESTORE_READY_ATTEMPTS"
require_uint NAV_RESTORE_READY_INTERVAL_SECONDS "$NAV_RESTORE_READY_INTERVAL_SECONDS"
require_uint NAV_TELEGRAM_TIMEOUT_SECONDS "$NAV_TELEGRAM_TIMEOUT_SECONDS"

"$RUN_ISOLATED" && ! is_true "$NAV_ENABLE_RESTORE_CONTAINER" \
  && fatal "$EX_CONFIG" "--run-isolated requires NAV_ENABLE_RESTORE_CONTAINER=true"

for command_name in stat realpath flock sha256sum mktemp install rm find sort cmp readlink; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

[[ "$BACKUP_DIR" == /* ]] || fatal "$EX_CONFIG" "--backup must be an absolute path"
[[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fatal "$EX_CONFIG" "backup must be a regular directory"
[[ ! -L "$NAV_BACKUP_ROOT" ]] || fatal "$EX_CONFIG" "backup root must not be a symlink"
backup_root_real="$(realpath -e -- "$NAV_BACKUP_ROOT")"
backup_real="$(realpath -e -- "$BACKUP_DIR")"
backup_base="$(basename "$backup_real")"
[[ "$backup_real" == "$backup_root_real"/nav-* ]] \
  || fatal "$EX_CONFIG" "backup is outside NAV_BACKUP_ROOT"
[[ "$backup_base" =~ ^nav-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]+$ ]] \
  || fatal "$EX_CONFIG" "backup directory name is not recognized"

dump_file="$backup_real/database/nav.dump"
manifest_file="$backup_real/manifest.sha256"
tree_file="$backup_real/metadata/tree.tsv"
public_tables_file="$backup_real/database/public-tables.txt"
count_file="$backup_real/database/table-counts.tsv"
migrations_file="$backup_real/database/schema-migrations.tsv"
[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" ]] \
  || fatal "$EX_VERIFY" "database dump is missing, empty, or not a regular file"
[[ -f "$manifest_file" && ! -L "$manifest_file" && -s "$manifest_file" ]] \
  || fatal "$EX_VERIFY" "checksum manifest is missing, empty, or not a regular file"
[[ "$(stat -c '%a' -- "$manifest_file")" == "600" ]] \
  || fatal "$EX_VERIFY" "checksum manifest mode is not 600"
[[ -f "$tree_file" && ! -L "$tree_file" && -s "$tree_file" ]] \
  || fatal "$EX_VERIFY" "tree manifest is missing, empty, or not a regular file"
[[ -f "$public_tables_file" && ! -L "$public_tables_file" && -s "$public_tables_file" ]] \
  || fatal "$EX_VERIFY" "public-table evidence is missing, empty, or not a regular file"
[[ -f "$count_file" && ! -L "$count_file" && -s "$count_file" ]] \
  || fatal "$EX_VERIFY" "table-count evidence is missing, empty, or not a regular file"
[[ -f "$migrations_file" && ! -L "$migrations_file" && -s "$migrations_file" ]] \
  || fatal "$EX_VERIFY" "schema_migrations evidence is missing, empty, or not a regular file"

if "$DRY_RUN"; then
  log "dry-run plan"
  log "backup: $backup_real"
  log "validation: exact tree, manifest.sha256, and pg_restore -l"
  log "isolated restore requested/configured: $RUN_ISOLATED/$(is_true "$NAV_ENABLE_RESTORE_CONTAINER" && echo true || echo false)"
  log "dry-run complete; no checksum process, container, report, alert, or deletion was performed"
  exit 0
fi

install -d -m 0755 -- "$(dirname "$NAV_RESTORE_LOCK_FILE")"
if [[ -e "$NAV_RESTORE_LOCK_FILE" || -L "$NAV_RESTORE_LOCK_FILE" ]]; then
  [[ -f "$NAV_RESTORE_LOCK_FILE" && ! -L "$NAV_RESTORE_LOCK_FILE" ]] \
    || fatal "$EX_CONFIG" "restore lock must be a regular non-symlink file"
  [[ "$(stat -c '%u' -- "$NAV_RESTORE_LOCK_FILE")" == "$EUID" ]] \
    || fatal "$EX_CONFIG" "restore lock must be owned by uid $EUID"
fi
exec 9>"$NAV_RESTORE_LOCK_FILE"
chmod 0600 "$NAV_RESTORE_LOCK_FILE"
flock -n 9 || fatal "$EX_TEMPFAIL" "another restore rehearsal is already running"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nav-restore-check.XXXXXXXX")"
chmod 0700 "$TEMP_DIR"

CURRENT_STAGE="exact backup tree verification"
actual_tree_file="$TEMP_DIR/actual-tree.tsv"
actual_regular_files="$TEMP_DIR/actual-regular-files.txt"
manifest_regular_files="$TEMP_DIR/manifest-regular-files.txt"

while IFS= read -r -d '' tree_entry; do
  relative_entry="${tree_entry#"$backup_real"/}"
  if [[ "$relative_entry" == *$'\t'* ||
        "$relative_entry" == *$'\r'* ||
        "$relative_entry" == *$'\n'* ||
        "$relative_entry" == *\\* ]]; then
    fatal "$EX_VERIFY" "backup tree contains an unsupported control character or backslash in a path"
  fi

  if [[ -L "$tree_entry" ]]; then
    if ! IFS= read -r -d '' link_target < <(readlink -z -- "$tree_entry"); then
      fatal "$EX_VERIFY" "could not read a symlink target in the backup tree"
    fi
    if [[ "$link_target" == *$'\t'* ||
          "$link_target" == *$'\r'* ||
          "$link_target" == *$'\n'* ||
          "$link_target" == *\\* ]]; then
      fatal "$EX_VERIFY" "backup tree contains an unsupported symlink target"
    fi
  elif [[ ! -f "$tree_entry" && ! -d "$tree_entry" ]]; then
    fatal "$EX_VERIFY" "backup tree contains an unsupported filesystem object: $relative_entry"
  fi
done < <(
  find -P "$backup_real" -mindepth 1 \
    ! -path "$manifest_file" -print0
)

find -P "$backup_real" -mindepth 1 \
  ! -path "$manifest_file" \
  -printf '%y\t%m\t%P\t%l\n' \
  | sort > "$actual_tree_file"
cmp -s "$tree_file" "$actual_tree_file" \
  || fatal "$EX_VERIFY" "backup tree differs from metadata/tree.tsv (extra, missing, or changed entry)"

find -P "$backup_real" -type f ! -path "$manifest_file" \
  -printf './%P\n' \
  | sort > "$actual_regular_files"
[[ -s "$actual_regular_files" ]] \
  || fatal "$EX_VERIFY" "backup contains no checksummable regular files"

manifest_line_regex='^([0-9a-f]{64})  (\./.+)$'
while IFS= read -r manifest_line || [[ -n "$manifest_line" ]]; do
  [[ "$manifest_line" =~ $manifest_line_regex ]] \
    || fatal "$EX_VERIFY" "checksum manifest contains an invalid line"
  manifest_path="${BASH_REMATCH[2]}"
  if [[ "$manifest_path" == *$'\t'* ||
        "$manifest_path" == *$'\r'* ||
        "$manifest_path" == *$'\n'* ||
        "$manifest_path" == *\\* ]]; then
    fatal "$EX_VERIFY" "checksum manifest contains an unsupported path"
  fi
  printf '%s\n' "$manifest_path" >> "$manifest_regular_files"
done < "$manifest_file"

cmp -s "$actual_regular_files" "$manifest_regular_files" \
  || fatal "$EX_VERIFY" "checksum manifest does not cover the exact regular-file set"
report "exact backup tree verification passed"

CURRENT_STAGE="checksum verification"
if ! (
  cd "$backup_real"
  sha256sum --check --quiet --strict manifest.sha256
); then
  fatal "$EX_VERIFY" "checksum verification failed"
fi
report "checksum verification passed"

CURRENT_STAGE="pg_restore catalog validation"
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore -l "$dump_file" > "$TEMP_DIR/pg_restore.list"
else
  command -v docker >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "pg_restore or docker is required"
  docker inspect "$NAV_DB_CONTAINER" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "database tool container is unavailable: $NAV_DB_CONTAINER"
  docker exec -i "$NAV_DB_CONTAINER" pg_restore -l \
    < "$dump_file" > "$TEMP_DIR/pg_restore.list"
fi
[[ -s "$TEMP_DIR/pg_restore.list" ]] || fatal "$EX_VERIFY" "pg_restore catalog is empty"
report "pg_restore catalog validation passed"

if ! "$RUN_ISOLATED"; then
  CURRENT_STAGE="complete"
  report "validation-only rehearsal complete; no restore container was started"
  exit 0
fi

CURRENT_STAGE="rehearsal report creation"
install -d -m 0700 -- "$NAV_REHEARSAL_REPORT_DIR"
report_timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
REPORT_FILE="$NAV_REHEARSAL_REPORT_DIR/${backup_base}-${report_timestamp}.tsv"
install -m 0600 /dev/null "$REPORT_FILE"
report "backup=$backup_real"
report "postgres_image=$NAV_RESTORE_POSTGRES_IMAGE"
report "exact_tree=passed"
report "manifest=passed"
report "pg_restore_catalog=passed"

CURRENT_STAGE="isolated PostgreSQL startup"
command -v docker >/dev/null 2>&1 || fatal "$EX_UNAVAILABLE" "docker is required"
docker image inspect "$NAV_RESTORE_POSTGRES_IMAGE" >/dev/null 2>&1 \
  || fatal "$EX_UNAVAILABLE" "restore image is not present locally; automatic pull is forbidden"
restore_image_id="$(docker image inspect --format '{{.Id}}' "$NAV_RESTORE_POSTGRES_IMAGE")"
report "postgres_image_id=$restore_image_id"

container_candidate="nav-restore-rehearsal-${report_timestamp,,}-$$"
docker inspect "$container_candidate" >/dev/null 2>&1 \
  && fatal "$EX_TEMPFAIL" "generated rehearsal container name already exists"
REHEARSAL_CONTAINER="$container_candidate"
docker run -d \
  --pull=never \
  --name "$REHEARSAL_CONTAINER" \
  --label nav.restore-rehearsal=true \
  --network none \
  --read-only \
  --tmpfs "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=$NAV_RESTORE_TMPFS_SIZE" \
  --tmpfs "/var/run/postgresql:rw,nosuid,nodev,noexec,size=32m" \
  --tmpfs "/tmp:rw,nosuid,nodev,noexec,size=64m" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=nav_rehearsal \
  -e POSTGRES_USER=nav_rehearsal \
  "$NAV_RESTORE_POSTGRES_IMAGE" >/dev/null

ready=false
for ((attempt=1; attempt<=NAV_RESTORE_READY_ATTEMPTS; attempt++)); do
  if docker exec "$REHEARSAL_CONTAINER" \
    pg_isready -U nav_rehearsal -d nav_rehearsal >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep "$NAV_RESTORE_READY_INTERVAL_SECONDS"
done
"$ready" || fatal "$EX_TEMPFAIL" "isolated PostgreSQL did not become ready"
report "isolated PostgreSQL is ready"

CURRENT_STAGE="isolated database restore"
if ! docker exec -i "$REHEARSAL_CONTAINER" \
  pg_restore \
  -U nav_rehearsal \
  -d nav_rehearsal \
  --exit-on-error \
  --no-owner \
  --no-acl < "$dump_file"; then
  fatal "$EX_VERIFY" "pg_restore into isolated PostgreSQL failed"
fi
report "isolated pg_restore completed"

CURRENT_STAGE="complete public-table set comparison"
actual_public_tables_file="$TEMP_DIR/restored-public-tables.txt"
docker exec "$REHEARSAL_CONTAINER" \
  psql -X -q -v ON_ERROR_STOP=1 \
  -U nav_rehearsal -d nav_rehearsal -Atc \
  "SELECT c.relname
     FROM pg_catalog.pg_class AS c
     JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
    ORDER BY c.relname;" > "$actual_public_tables_file"
cmp -s "$public_tables_file" "$actual_public_tables_file" \
  || fatal "$EX_VERIFY" "restored public-table set differs from the backup snapshot"

expected_table_count=0
while IFS= read -r table_name || [[ -n "$table_name" ]]; do
  [[ "$table_name" =~ ^[a-z_][a-z0-9_]*$ ]] \
    || fatal "$EX_VERIFY" "invalid table name in public-table evidence: $table_name"
  expected_table_count=$((expected_table_count + 1))
done < "$public_tables_file"
(( expected_table_count > 0 )) \
  || fatal "$EX_VERIFY" "public-table evidence is empty"
report "public_table_set=match tables=$expected_table_count"

CURRENT_STAGE="complete public-table row-count comparison"
count_table_names="$TEMP_DIR/count-table-names.txt"
first_count_line=true
while IFS=$'\t' read -r table_name expected_rows; do
  if "$first_count_line"; then
    [[ "$table_name" == "table" && "$expected_rows" == "rows" ]] \
      || fatal "$EX_VERIFY" "table-count evidence has an invalid header"
    first_count_line=false
    continue
  fi
  [[ -z "$table_name" ]] && continue
  [[ "$table_name" =~ ^[a-z_][a-z0-9_]*$ ]] \
    || fatal "$EX_VERIFY" "invalid table name in count evidence: $table_name"
  [[ "$expected_rows" =~ ^[0-9]+$ ]] \
    || fatal "$EX_VERIFY" "invalid expected row count for $table_name"
  printf '%s\n' "$table_name" >> "$count_table_names"

  actual_rows="$(docker exec "$REHEARSAL_CONTAINER" \
    psql -X -U nav_rehearsal -d nav_rehearsal -Atqc \
    "SELECT count(*) FROM public.\"${table_name}\";")"
  [[ "$actual_rows" =~ ^[0-9]+$ ]] \
    || fatal "$EX_VERIFY" "invalid restored row count for $table_name"
  [[ "$actual_rows" == "$expected_rows" ]] \
    || fatal "$EX_VERIFY" "row-count mismatch for $table_name: expected $expected_rows, got $actual_rows"
  report "table=$table_name rows=$actual_rows status=match"
done < "$count_file"
if "$first_count_line"; then
  fatal "$EX_VERIFY" "table-count evidence is empty"
fi
cmp -s "$public_tables_file" "$count_table_names" \
  || fatal "$EX_VERIFY" "table-count evidence does not cover the exact public-table set"

CURRENT_STAGE="schema_migrations content comparison"
restored_migrations_file="$TEMP_DIR/restored-schema-migrations.tsv"
docker exec "$REHEARSAL_CONTAINER" \
  psql -X -q -v ON_ERROR_STOP=1 \
  -U nav_rehearsal -d nav_rehearsal -Atc \
  "COPY (
     SELECT id,
            name,
            executed_at AT TIME ZONE 'UTC' AS executed_at_utc
       FROM public.schema_migrations
      ORDER BY id, name
   ) TO STDOUT WITH (FORMAT csv, DELIMITER E'\t', HEADER true, FORCE_QUOTE *);" \
  > "$restored_migrations_file"
cmp -s "$migrations_file" "$restored_migrations_file" \
  || fatal "$EX_VERIFY" "schema_migrations content differs from the backup snapshot"
report "schema_migrations=exact_match"

CURRENT_STAGE="isolated container cleanup"
cleanup_container
CURRENT_STAGE="complete"
report "restore rehearsal passed"
exit 0
