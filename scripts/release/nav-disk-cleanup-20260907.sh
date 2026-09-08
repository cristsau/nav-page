#!/usr/bin/env bash
# One-time approved cleanup. Exact historical image IDs, no volume/release pruning.
set -Eeuo pipefail
umask 077
export LC_ALL=C
[[ ${EUID} == 0 ]] || exit 77
exec 9>/run/lock/nav-backup.lock
flock -n 9 || { printf 'BLOCKED: backup/recovery lock busy\n'; exit 75; }
readonly expected_current=/opt/nav-stack/releases/20260907-140500-b2ae023
readonly expected_rollback=/opt/nav-stack/releases/20260903-160400-94543f6
readonly backup=/var/backups/nav/nav-20260907T062639Z-nogit
readonly -a revisions=(
  d774916e93cba8bb65120a780d9e265b836e4463
  a7c00709545644587bda6113c8039d7e1acbba67
  cec07bb4df050cd9814336ac10a435605482c770
  0107844c63e6de48250c2d3379ae43e0c16cc84e
  c8a0f06400e618937cf9c3344353f377a161c5da
  955fb5c7186e1fa25b0e3a7a24f6f7adcaf98b25
)
readonly -a image_ids=(
  sha256:08f1830874bb2d10d567ab6b73ef86ce52861ada7cecd18a91e37f4fdf664c17
  sha256:242ba2e218157391f998aec7c9fe4ab737b77c5069b66e4ce37c83ad3e77c9f6
  sha256:25342ace23e9ea0c6e7a9a440ff0f8aad52ea017c6b59eaed16d3b45fd8663bd
  sha256:e80b8f49de1b5e400a522c330e71a98e6e6320e8eb6cea9d4cd64ccdbc03fe6c
  sha256:26d8aa29e5768b25da20faadcbe03206c480abf592fd7da549011d4ef1503191
  sha256:f01e8de0ac932be89493bb5a949ce7a0e9641bf99b1316ca5a4ce1112d1f9d9a
)
check_links() {
  [[ $(readlink -f /opt/nav-stack/current) == "$expected_current" ]]
  [[ $(readlink -f /opt/nav-stack/rollback) == "$expected_rollback" ]]
}
container_fingerprint() {
  local ids
  ids=$(docker ps -aq --no-trunc | sort)
  [[ -n "$ids" ]]
  # Excludes environment, arguments, credentials and personal data.
  docker inspect --format '{{.Id}}|{{.Image}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{json .Mounts}}' $ids | python3 -c '
import hashlib, json, sys
rows = []
for line in sys.stdin:
    fields = line.rstrip("\n").split("|", 5)
    mounts = sorted(json.loads(fields[5]), key=lambda item: item["Destination"])
    fields[5] = json.dumps(mounts, sort_keys=True, separators=(",", ":"))
    rows.append("|".join(fields))
print(hashlib.sha256("\n".join(sorted(rows)).encode()).hexdigest())'
}
assert_unused() {
  local image=$1 containers used
  containers=$(docker ps -aq --no-trunc)
  used=$(docker inspect --format '{{.Image}}' $containers)
  if grep -Fxq -- "$image" <<< "$used"; then
    printf 'BLOCKED: image became container-referenced\n'; exit 75
  fi
}
check_links
if ps -eo comm= | grep -Eq '^ *(apt|apt-get|dpkg|buildctl|buildx|npm|make|cc1|cc1plus)$'; then
  printf 'BLOCKED: build/package operation active\n'; exit 75
fi
before_containers=$(container_fingerprint)
before_available=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
protected_images=$(docker image inspect --format '{{.Id}}' \
  nav-ovh-api:b2ae02360d7837f0b5c21daaaa855d986b600b2b \
  nav-ovh-api:94543f66d1433912737fd5973e145e78084276b2 \
  nav-ovh-api:888a31cd3dd992b918b9aae146c1721aa466c5e8 \
  postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685)
(cd "$backup" && sha256sum --quiet -c manifest.sha256)
for index in "${!revisions[@]}"; do
  revision=${revisions[$index]}
  expected=${image_ids[$index]}
  actual=$(docker image inspect --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "nav-ovh-api:$revision")
  [[ $actual == "$expected|$revision" ]]
  assert_unused "$expected"
  source_archive=/opt/nav-stack/incoming/nav-source-$revision.tar.gz
  [[ -f "$source_archive" && ! -L "$source_archive" ]]
  gzip -t "$source_archive"
done
printf 'PREFLIGHT_PASS available_bytes=%s containers=%s\n' "$before_available" "$before_containers"
for image in "${image_ids[@]}"; do
  check_links
  [[ $(container_fingerprint) == "$before_containers" ]]
  assert_unused "$image"
  docker image rm "$image"
done
# Engine-managed cache removal preserves image/container references and in-use records.
docker buildx prune --builder default --all --force --filter 'until=24h'
for cache in /var/cache/apt/pkgcache.bin /var/cache/apt/srcpkgcache.bin; do
  [[ -f "$cache" && ! -L "$cache" && $(realpath -e "$cache") == "$cache" ]]
  if command -v fuser >/dev/null && fuser "$cache" >/dev/null 2>&1; then
    printf 'PRESERVED_BUSY_CACHE %s\n' "$cache"
  else
    rm -- "$cache"
    [[ ! -e "$cache" ]]
    printf 'REMOVED_REGENERABLE_CACHE %s\n' "$cache"
  fi
done
for image in "${image_ids[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    printf 'FAILED: removed image still present\n'; exit 70
  fi
done
while IFS= read -r image; do docker image inspect "$image" >/dev/null; done <<< "$protected_images"
check_links
[[ $(container_fingerprint) == "$before_containers" ]]
(cd "$backup" && sha256sum --quiet -c manifest.sha256)
for domain in nav.skrskr.net nav.cristsau.cn; do
  code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "https://$domain/api/health")
  printf 'HEALTH %s %s\n' "$domain" "$code"
  [[ $code == 200 ]]
done
after_available=$(df -B1 --output=avail / | tail -1 | tr -d ' ')
printf 'CLEANUP_PASS before_available_bytes=%s after_available_bytes=%s released_bytes=%s\n' \
  "$before_available" "$after_available" "$((after_available-before_available))"
printf 'CONTAINERS_UNCHANGED BACKUP_HASH_PASS PROTECTED_IMAGES_PASS RELEASE_POINTERS_UNCHANGED\n'
df -h /
docker system df
