#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_CANTCREAT=73
readonly EX_TEMPFAIL=75
readonly EX_CONFIG=78

PROGRAM_NAME="$(basename "$0")"
STACK_ROOT="${NAV_STACK_ROOT:-/opt/nav-stack}"
LOCK_FILE="${NAV_RELEASE_LOCK_FILE:-/run/lock/nav-release-link.lock}"
ACTION=""
RELEASE_DIR=""
TEMP_LINK=""
LOCK_FD=9

log() {
  printf '%s [%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$PROGRAM_NAME" "$*" >&2
}

fatal() {
  local code="$1"
  shift
  log "ERROR: $*"
  exit "$code"
}

cleanup() {
  if [[ -n "$TEMP_LINK" && -L "$TEMP_LINK" ]]; then
    rm -f -- "$TEMP_LINK"
  fi
  TEMP_LINK=""
}

trap cleanup EXIT
trap 'fatal 130 "interrupted by signal"' INT TERM

usage() {
  cat <<'EOF'
Usage:
  nav-release-link.sh switch /opt/nav-stack/releases/YYYYmmdd-HHMMSS-abcdef0
  nav-release-link.sh rollback
  nav-release-link.sh status

The current symlink is replaced atomically. A switch records the previous
current target as rollback; rollback swaps the two verified release targets.
EOF
}

while (($#)); do
  case "$1" in
    switch)
      [[ -z "$ACTION" && $# -ge 2 ]] || { usage >&2; exit "$EX_USAGE"; }
      ACTION=switchover
      RELEASE_DIR="$2"
      shift 2
      ;;
    rollback|status)
      [[ -z "$ACTION" ]] || { usage >&2; exit "$EX_USAGE"; }
      ACTION="$1"
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

[[ -n "$ACTION" ]] || { usage >&2; exit "$EX_USAGE"; }

for command_name in stat realpath readlink ln mv flock install rm dirname basename; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

[[ "$STACK_ROOT" == /* && "$STACK_ROOT" != / ]] \
  || fatal "$EX_CONFIG" "NAV_STACK_ROOT must be one non-root absolute path"
[[ -d "$STACK_ROOT" && ! -L "$STACK_ROOT" ]] \
  || fatal "$EX_CONFIG" "stack root must be a non-symlink directory"
stack_real="$(realpath -e -- "$STACK_ROOT")"
[[ "$(stat -c '%u' -- "$stack_real")" == "$EUID" ]] \
  || fatal "$EX_CONFIG" "stack root must be owned by uid $EUID"
stack_mode="$(stat -c '%a' -- "$stack_real")"
(( (8#$stack_mode & 002) == 0 )) \
  || fatal "$EX_CONFIG" "stack root must not be world writable"

releases_root="$stack_real/releases"
[[ -d "$releases_root" && ! -L "$releases_root" ]] \
  || fatal "$EX_CONFIG" "release root must be a non-symlink directory"
releases_real="$(realpath -e -- "$releases_root")"
[[ "$(dirname "$releases_real")" == "$stack_real" ]] \
  || fatal "$EX_CONFIG" "release root escaped the stack root"

current_link="$stack_real/current"
rollback_link="$stack_real/rollback"

validate_release() {
  local candidate="$1"
  local resolved base
  [[ "$candidate" == /* && -d "$candidate" && ! -L "$candidate" ]] \
    || return 1
  resolved="$(realpath -e -- "$candidate")" || return 1
  [[ "$(dirname "$resolved")" == "$releases_real" ]] || return 1
  base="$(basename "$resolved")"
  [[ "$base" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{7,40}$ ]] || return 1
  printf '%s\n' "$resolved"
}

resolve_release_link() {
  local link="$1"
  local target
  [[ -L "$link" ]] || return 1
  target="$(readlink -f -- "$link")" || return 1
  validate_release "$target"
}

atomic_link() {
  local target="$1"
  local destination="$2"
  local name
  name="$(basename "$destination")"
  TEMP_LINK="$stack_real/.${name}.new.$$"
  [[ ! -e "$TEMP_LINK" && ! -L "$TEMP_LINK" ]] \
    || fatal "$EX_CANTCREAT" "temporary link already exists"
  ln -s -- "$target" "$TEMP_LINK"
  mv -Tf -- "$TEMP_LINK" "$destination"
  TEMP_LINK=""
}

if [[ "$ACTION" == status ]]; then
  current_target="$(resolve_release_link "$current_link" 2>/dev/null || true)"
  rollback_target="$(resolve_release_link "$rollback_link" 2>/dev/null || true)"
  printf 'current=%s\nrollback=%s\n' "${current_target:-missing}" "${rollback_target:-missing}"
  [[ -n "$current_target" ]] || exit "$EX_CONFIG"
  exit 0
fi

lock_parent="$(dirname "$LOCK_FILE")"
[[ "$LOCK_FILE" == /* && "$lock_parent" != / ]] \
  || fatal "$EX_CONFIG" "release lock path is unsafe"
if [[ ! -e "$lock_parent" && ! -L "$lock_parent" ]]; then
  install -d -m 0755 -- "$lock_parent"
fi
[[ -d "$lock_parent" && ! -L "$lock_parent" ]] \
  || fatal "$EX_CONFIG" "release lock parent must be a non-symlink directory"
exec 9>>"$LOCK_FILE"
chmod 0600 "$LOCK_FILE"
flock -n "$LOCK_FD" || fatal "$EX_TEMPFAIL" "another release switch is running"

current_target="$(resolve_release_link "$current_link" 2>/dev/null || true)"

if [[ "$ACTION" == switchover ]]; then
  next_target="$(validate_release "$RELEASE_DIR")" \
    || fatal "$EX_CONFIG" "release target is not one verified direct child of releases"
  if [[ "$next_target" == "$current_target" ]]; then
    log "current already points to $(basename "$next_target")"
    exit 0
  fi
  if [[ -n "$current_target" ]]; then
    atomic_link "$current_target" "$rollback_link"
  fi
  atomic_link "$next_target" "$current_link"
  log "current=$(basename "$next_target") rollback=$(basename "${current_target:-none}")"
  exit 0
fi

rollback_target="$(resolve_release_link "$rollback_link" 2>/dev/null || true)"
[[ -n "$current_target" && -n "$rollback_target" ]] \
  || fatal "$EX_CONFIG" "rollback requires verified current and rollback links"
[[ "$current_target" != "$rollback_target" ]] \
  || fatal "$EX_CONFIG" "current and rollback targets must differ"
atomic_link "$rollback_target" "$current_link"
atomic_link "$current_target" "$rollback_link"
log "rollback complete: current=$(basename "$rollback_target") rollback=$(basename "$current_target")"
