#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
package_root=$(pwd -P)
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Requires Linux x86-64 and Docker Engine (not Windows containers).'
for tool in docker sha256sum; do command -v "$tool" >/dev/null || fail "Missing prerequisite: $tool"; done
[[ -f SHA256SUMS && -f image-lock.json && -f package-info.json ]] || fail 'Use the prepared release archive, not an incomplete source folder.'
sha256sum --check --status SHA256SUMS || fail 'Package integrity check failed; nothing was installed.'
docker compose version >/dev/null || fail 'Install Docker Compose v2 first. This script never modifies the host Docker installation.'
engine=$(docker info --format '{{.OSType}}/{{.Architecture}}')
[[ $engine == linux/x86_64 || $engine == linux/amd64 ]] || fail 'The selected Docker daemon must be Linux x86-64.'
docker_host=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
[[ $docker_host == unix://* && -z ${DOCKER_HOST:-} ]] || fail 'Use a local Unix-socket Docker context; remote daemons are not supported.'
[[ $package_root != / && $package_root != "$HOME" && $package_root != *','* ]] || fail 'Extract into a dedicated directory (no comma in its path).'
if [[ -e config || -e .env || -L config || -L .env ]]; then
  fail 'Existing/partial configuration found. Use bash manage.sh start to resume; no data or secrets were changed.'
fi
mode=local
origin=https://localhost:8443
case ${1:-} in
  '') ;;
  --public)
    mode=public
    printf 'Public mode binds this new stack to 0.0.0.0:80 and :443. DNS must point here; existing web servers must keep their ports.\n'
    read -r -p 'Your HTTPS origin (example https://nav.example.com): ' origin
    read -r -p 'Confirm this new public deployment by typing PUBLIC: ' confirmation
    [[ $confirmation == PUBLIC ]] || fail 'Cancelled.'
    ;;
  *) fail 'Usage: bash install.sh [--public]' ;;
esac
read -r -p 'Administrator username (3-32 lowercase characters): ' username
read -r -s -p 'Administrator passphrase (15-128 characters): ' password; printf '\n'
read -r -s -p 'Repeat passphrase: ' repeated; printf '\n'
[[ $password == "$repeated" ]] || fail 'Passphrases do not match; nothing was installed.'
# Public image reference only, read without executing .env or shell-sourcing JSON.
node_image=$(sed -n 's/^[[:space:]]*"node": "\([^"]*\)"[,]\{0,1\}$/\1/p' image-lock.json)
[[ $node_image =~ ^node:[a-zA-Z0-9.-]+@sha256:[a-f0-9]{64}$ ]] || fail 'Invalid pinned Node image.'
printf '%s\n' "$mode" "$origin" "$username" "$password" | docker run --rm -i --network none \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$package_root,dst=/package" -w /package "$node_image" node setup.mjs
unset password repeated
exec bash manage.sh start
