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
STACK_ROOT="${NAV_STACK_ROOT:-/opt/nav-stack}"
LOG_RETENTION_SCRIPT="${NAV_LOG_RETENTION_SCRIPT:-/etc/cron.daily/nav-log-retention}"
APPLY=false
RELEASE_MIN_AGE_DAYS=1

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
Usage: nav-controlled-cleanup.sh [--dry-run|--apply] [--release-min-age-days N]

Dry-run is the default. Apply keeps the verified current and rollback releases,
keeps every release used as a bind source by any running or stopped container,
removes only older verified NAV release directories, retains 30 days of logs,
prunes Docker dangling layers, and removes only unreferenced NAV API images. It
never prunes containers, networks, volumes, build cache or non-NAV images.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run)
      APPLY=false
      shift
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    --release-min-age-days)
      (($# >= 2)) || { usage >&2; exit "$EX_USAGE"; }
      RELEASE_MIN_AGE_DAYS="$2"
      shift 2
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

[[ "$RELEASE_MIN_AGE_DAYS" =~ ^[0-9]+$ && "$RELEASE_MIN_AGE_DAYS" -le 365 ]] \
  || fatal "$EX_USAGE" "release minimum age must be from 0 to 365 days"
for command_name in stat realpath readlink find basename dirname docker; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fatal "$EX_UNAVAILABLE" "required command is unavailable: $command_name"
done

[[ "$STACK_ROOT" == /* && "$STACK_ROOT" != / && -d "$STACK_ROOT" && ! -L "$STACK_ROOT" ]] \
  || fatal "$EX_CONFIG" "stack root must be one non-root absolute non-symlink directory"
stack_real="$(realpath -e -- "$STACK_ROOT")"
releases_real="$(realpath -e -- "$stack_real/releases")"
[[ "$(dirname "$releases_real")" == "$stack_real" && ! -L "$stack_real/releases" ]] \
  || fatal "$EX_CONFIG" "release root escaped the stack root"

resolve_release_link() {
  local link="$1"
  local target base
  [[ -L "$link" ]] || return 1
  target="$(readlink -f -- "$link")" || return 1
  [[ -d "$target" && ! -L "$target" && "$(dirname "$target")" == "$releases_real" ]] \
    || return 1
  base="$(basename "$target")"
  [[ "$base" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{7,40}$ ]] || return 1
  printf '%s\n' "$target"
}

protected_bind_source=''
release_has_container_bind_source() {
  local release="$1"
  local container_output mount_output bind_source bind_real
  local -a inspected_container_ids=()
  protected_bind_source=''

  container_output="$(docker ps -aq)" \
    || fatal "$EX_UNAVAILABLE" "could not enumerate Docker containers for release bind protection"
  [[ -n "$container_output" ]] || return 1
  mapfile -t inspected_container_ids <<< "$container_output"
  mount_output="$(
    docker inspect --format \
      '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}' \
      "${inspected_container_ids[@]}"
  )" || fatal "$EX_UNAVAILABLE" "could not inspect Docker bind sources"

  while IFS= read -r bind_source; do
    [[ -n "$bind_source" ]] || continue
    [[ "$bind_source" == /* ]] \
      || fatal "$EX_CONFIG" "Docker reported a non-absolute bind source"
    bind_real="$(realpath -m -- "$bind_source")" \
      || fatal "$EX_CONFIG" "could not normalize Docker bind source"
    if [[ "$bind_real" == "$release" || "$bind_real" == "$release/"* ]]; then
      protected_bind_source="$bind_real"
      return 0
    fi
  done <<< "$mount_output"
  return 1
}

current_target="$(resolve_release_link "$stack_real/current")" \
  || fatal "$EX_CONFIG" "current release link is missing or invalid"
rollback_target="$(resolve_release_link "$stack_real/rollback")" \
  || fatal "$EX_CONFIG" "rollback release link is missing or invalid"
[[ "$current_target" != "$rollback_target" ]] \
  || fatal "$EX_CONFIG" "current and rollback must be different releases"

current_prefix="${current_target##*-}"
rollback_prefix="${rollback_target##*-}"
declare -a release_candidates=()
while IFS= read -r -d '' candidate; do
  [[ "$candidate" == "$current_target" || "$candidate" == "$rollback_target" ]] && continue
  base="$(basename "$candidate")"
  [[ "$base" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{7,40}$ ]] || continue
  [[ ! -L "$candidate" && "$(dirname "$(realpath -e -- "$candidate")")" == "$releases_real" ]] \
    || fatal "$EX_CONFIG" "release candidate escaped the verified release root"
  if release_has_container_bind_source "$candidate"; then
    log "preserve container-bound release: $candidate (bind source: $protected_bind_source)"
    continue
  fi
  release_candidates+=("$candidate")
done < <(
  find -P "$releases_real" -mindepth 1 -maxdepth 1 -type d \
    -mtime "+$RELEASE_MIN_AGE_DAYS" -print0
)

declare -A used_image_ids=()
mapfile -t container_ids < <(docker ps -aq)
if ((${#container_ids[@]})); then
  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] && used_image_ids["$image_id"]=true
  done < <(docker inspect --format '{{.Image}}' "${container_ids[@]}")
fi

declare -a nav_image_candidates=()
while IFS=$'\t' read -r repository image_id; do
  [[ "$repository" == domo-nav-api || "$repository" == nav-ovh-api ]] || continue
  [[ -z "${used_image_ids[$image_id]+present}" ]] || continue
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id" 2>/dev/null || true)"
  # A stopped rollback image without a trustworthy revision label cannot be
  # associated safely with one release. Preserve it instead of guessing.
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || continue
  [[ "$revision" == "$current_prefix"* || "$revision" == "$rollback_prefix"* ]] && continue
  nav_image_candidates+=("$image_id")
done < <(docker image ls --no-trunc --format '{{.Repository}}\t{{.ID}}')

log "preserve current=$(basename "$current_target") rollback=$(basename "$rollback_target")"
for candidate in "${release_candidates[@]}"; do
  log "release candidate: $candidate"
done
for image_id in "${nav_image_candidates[@]}"; do
  log "unreferenced NAV image candidate: $image_id"
done

if ! "$APPLY"; then
  log "dry-run complete: releases=${#release_candidates[@]} nav_images=${#nav_image_candidates[@]}"
  log "no file, log, image, container, network, volume or cache was changed"
  exit 0
fi

(( EUID == 0 )) || fatal "$EX_CONFIG" "--apply must run as root"
[[ -f "$LOG_RETENTION_SCRIPT" && ! -L "$LOG_RETENTION_SCRIPT" && -x "$LOG_RETENTION_SCRIPT" ]] \
  || fatal "$EX_CONFIG" "log retention script must be an executable regular non-symlink file"
"$LOG_RETENTION_SCRIPT" \
  || fatal "$EX_SOFTWARE" "30-day log retention failed"

# Revalidate every planned release before the first removal. A container may
# have been created or stopped after the dry-run plan was assembled.
for candidate in "${release_candidates[@]}"; do
  candidate_real="$(realpath -e -- "$candidate")"
  [[ "$(dirname "$candidate_real")" == "$releases_real" \
      && "$candidate_real" != "$current_target" \
      && "$candidate_real" != "$rollback_target" \
      && ! -L "$candidate" ]] \
    || fatal "$EX_CONFIG" "release changed after planning; refusing cleanup"
  release_has_container_bind_source "$candidate_real" \
    && fatal "$EX_CONFIG" \
      "release became a Docker bind source after planning: $candidate_real ($protected_bind_source)"
done

for candidate in "${release_candidates[@]}"; do
  candidate_real="$(realpath -e -- "$candidate")"
  [[ "$(dirname "$candidate_real")" == "$releases_real" \
      && "$candidate_real" != "$current_target" \
      && "$candidate_real" != "$rollback_target" \
      && ! -L "$candidate" ]] \
    || fatal "$EX_CONFIG" "release changed before removal; refusing cleanup"
  release_has_container_bind_source "$candidate_real" \
    && fatal "$EX_CONFIG" \
      "release became a Docker bind source before removal: $candidate_real ($protected_bind_source)"
  rm -rf --one-file-system -- "$candidate_real"
  log "removed old NAV release: $candidate_real"
done

docker image prune --force --filter dangling=true >/dev/null \
  || fatal "$EX_SOFTWARE" "Docker dangling-image prune failed"
for image_id in "${nav_image_candidates[@]}"; do
  docker image inspect "$image_id" >/dev/null 2>&1 || continue
  docker image rm "$image_id" >/dev/null \
    || fatal "$EX_SOFTWARE" "could not remove unreferenced NAV image: $image_id"
done
log "controlled cleanup complete; containers, networks, volumes, build cache and non-NAV images were preserved"
