#!/usr/bin/env bash
# PostgreSQL 16 + API tests in an isolated network namespace, no production mounts.
set -Eeuo pipefail
umask 077
archive=${1:?exact uploaded source archive required}
expected_hash=${2:?expected sha256 required}
candidate_image=${3:?exact new candidate image sha256 required}
candidate_revision=${4:?exact new candidate revision required}
[[ "$candidate_image" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$candidate_revision" =~ ^[a-f0-9]{40}$ ]]
[[ $(docker image inspect --format '{{.Id}}' "$candidate_image") == "$candidate_image" ]]
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$candidate_image") == "$candidate_revision" ]]
[[ "$archive" =~ ^/tmp/nav-auth-test-[0-9]{14}\.tar\.gz$ && ! -L "$archive" && -f "$archive" ]]
[[ $(realpath -e "$archive") == "$archive" ]]
[[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]]
[[ $(sha256sum "$archive" | cut -d' ' -f1) == "$expected_hash" ]]
run_id=${archive##*/};run_id=${run_id%.tar.gz}
pg_id='';runner_id=''
cleanup() {
  local outcome=$?
  trap - EXIT
  for cid in "$runner_id" "$pg_id"; do
    [[ -n "$cid" ]] || continue
    [[ $(docker inspect --format '{{index .Config.Labels "nav.auth-test"}}' "$cid") == "$run_id" ]] || exit 70
    docker rm -f "$cid" >/dev/null || outcome=70
  done
  printf 'ISOLATED_TEST_CLEANUP_COMPLETE exit=%s\n' "$outcome"
  exit "$outcome"
}
trap cleanup EXIT
pg_id=$(docker run -d --name "$run_id-pg" --label "nav.auth-test=$run_id" \
  --network none --memory 192m --cpus 0.5 --tmpfs /var/lib/postgresql/data:rw,size=128m \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=nav_auth_email_test \
  postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685)
ready=false
for ((i=0;i<30;i++)); do
  if docker exec "$pg_id" pg_isready -U postgres -d nav_auth_email_test >/dev/null; then ready=true;break;fi
  sleep 1
done
[[ "$ready" == true ]]
runner_id=$(docker create --name "$run_id-api" --label "nav.auth-test=$run_id" \
  --network "container:$pg_id" --memory 384m --cpus 0.5 \
  -e NODE_ENV=test -e NAV_AUTH_EMAIL_INTEGRATION_TEST=true \
  -e NAV_AUTH_RESTORE_SCRIPT=/app/nav-disaster-restore.sh \
  -e DATABASE_URL=postgres://postgres@127.0.0.1:5432/nav_auth_email_test \
  --entrypoint sh "$candidate_image" \
  -c 'tar -xzf /tmp/auth-test-source.tar.gz -C /app && cd /app && node --test integration/authEmailPostgres.integration.js && exec node src/db/verifyMigrations.js')
docker cp "$archive" "$runner_id:/tmp/auth-test-source.tar.gz"
docker start -a "$runner_id"
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$runner_id")
[[ "$exit_code" == 0 ]]
