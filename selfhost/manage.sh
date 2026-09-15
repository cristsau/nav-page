#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ -f .env && ! -L .env && -f config/settings.json && ! -L config ]] || fail 'Run install.sh first; do not overwrite a partial installation.'
[[ -z ${DOCKER_HOST:-} ]] || fail 'Remote/overridden Docker endpoints are not supported.'
docker_host=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
[[ $docker_host == unix://* ]] || fail 'Use the original local Docker Unix-socket context.'
dc() { docker compose --env-file .env -f compose.yaml "$@"; }
case ${1:-status} in
  start)
    dc config --quiet
    dc up -d --build --wait --wait-timeout 240
    printf 'Containers are healthy. Open the origin you selected. Use account/password login.\n'
    printf 'Local mode: https://localhost:8443 — trust your own local CA first (see README). Public DNS/TLS still needs external verification.\n'
    ;;
  status) dc ps ;;
  stop) dc stop ;;
  logs) dc logs --tail 80 api web ;;
  local-ca)
    [[ ! -e domonav-local-ca.crt && ! -L domonav-local-ca.crt ]] || fail 'domonav-local-ca.crt already exists; refusing overwrite.'
    dc cp web:/data/caddy/pki/authorities/local/root.crt ./domonav-local-ca.crt
    printf 'Exported PUBLIC root certificate only. Verify ownership before manually trusting it on your device. No system trust store was changed.\n'
    ;;
  backup)
    # A stopped application is required so the DB + integration secrets form one snapshot.
    [[ ${2:-} == --allow-pause ]] || fail 'Backup briefly stops this stack web/API. Run: bash manage.sh backup --allow-pause (only when no users are editing).'
    dc exec -T db pg_isready -U nav -d nav >/dev/null
    running=$(dc ps --status running --services)
    [[ $'\n'$running$'\n' == *$'\napi\n'* && $'\n'$running$'\n' == *$'\nweb\n'* ]] || fail 'Backup expects web and API to be running so their prior state can be restored.'
    mkdir -p -- backups
    [[ ! -L backups ]] || fail 'Backup directory cannot be a symlink.'
    backup_dir=$(mktemp -d "$(pwd -P)/backups/nav-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
    restore_services() {
      result=$?
      trap - EXIT
      if ! dc up -d --wait --wait-timeout 240 web api >/dev/null; then
        printf 'Restart failed: run bash manage.sh start\n' >&2
        exit 1
      fi
      exit "$result"
    }
    trap restore_services EXIT
    dc stop web api
    dc exec -T db pg_dump -U nav -d nav -Fc > "$backup_dir/database.dump"
    dc run --rm --no-deps -T --entrypoint node api -e 'const fs=require("fs");const cp=require("child_process");cp.execFileSync("tar",["-czf","/tmp/integrations.tar.gz","-C","/data","integrations"]);process.stdout.write(fs.readFileSync("/tmp/integrations.tar.gz"));' > "$backup_dir/integrations.tar.gz"
    tar -czf "$backup_dir/config.tar.gz" .env config image-lock.json package-info.json
    (cd "$backup_dir" && sha256sum database.dump integrations.tar.gz config.tar.gz > SHA256SUMS)
    printf 'Private backup created: %s\nContains secrets and user data; encrypt before moving off this host. No restore has been performed.\n' "$backup_dir"
    ;;
  *) fail 'Usage: bash manage.sh {start|status|stop|logs|local-ca|backup --allow-pause}' ;;
esac
