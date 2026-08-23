#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077
export LC_ALL=C

[[ "${CI:-}" == true && "${NAV_RELEASE_ACCEPTANCE_SHELL_TEST:-}" == true ]] || {
  printf '%s\n' 'refusing to run outside the explicit CI shell-test gate' >&2
  exit 78
}
[[ "$EUID" == 0 ]] || {
  printf '%s\n' 'shell lifecycle test must run as root in isolated CI' >&2
  exit 78
}

for dependency in flock grep mktemp python3 realpath setsid; do
  command -v "$dependency" >/dev/null 2>&1 || {
    printf 'missing test dependency: %s\n' "$dependency" >&2
    exit 69
  }
done

ROOT="$(realpath -e -- "$(dirname -- "$0")/../..")"
WRAPPER="$ROOT/scripts/release/nav-with-ephemeral-admin.sh"
TEST_ROOT="$(mktemp -d /tmp/nav-release-acceptance-shell.XXXXXX)"
RELEASE_SHA='abcdef0123456789abcdef0123456789abcdef01'
RELEASE_DIR="$TEST_ROOT/releases/ci-${RELEASE_SHA:0:7}"
FAKE_BIN="$TEST_ROOT/bin"
FAKE_STATE="$TEST_ROOT/fake-state"
COMMAND="$TEST_ROOT/acceptance-command.sh"

cleanup() {
  local test_real
  test_real="$(realpath -e -- "$TEST_ROOT" 2>/dev/null || true)"
  if [[ "$test_real" == /tmp/nav-release-acceptance-shell.* ]]; then
    rm -rf -- "$test_real"
  fi
}
trap cleanup EXIT

mkdir -p "$RELEASE_DIR/evidence" "$FAKE_BIN" "$FAKE_STATE"
chmod 700 "$TEST_ROOT" "$TEST_ROOT/releases" "$RELEASE_DIR" "$RELEASE_DIR/evidence" "$FAKE_BIN" "$FAKE_STATE"

cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

state_dir="${NAV_TEST_FAKE_DOCKER_STATE:?}"
release_sha="${NAV_TEST_RELEASE_SHA:?}"

if [[ "${1:-}" == inspect && "${2:-}" == -f ]]; then
  format="${3:-}"
  container="${4:-}"
  case "$format" in
    *'.State.Status'*) printf '%s\n' running ;;
    *'.State.Health'*) printf '%s\n' healthy ;;
    *'org.opencontainers.image.revision'*) printf '%s\n' "$release_sha" ;;
    *'.NetworkSettings.Networks'*) printf '%s\n' '172.20.0.2' ;;
    *) printf 'unsupported inspect format for %s: %s\n' "$container" "$format" >&2; exit 2 ;;
  esac
  exit 0
fi

[[ "${1:-}" == exec ]] || exit 2
shift
[[ "${1:-}" == -i ]] && shift
container="${1:-}"
shift

if [[ "$container" == nav-postgres-test && "${1:-}" == psql ]]; then
  printf '%s\t%s\t%s\n' nav 16384 160010
  exit 0
fi

[[ "$container" == nav-api-test ]] || exit 2
if [[ "${1:-}" == test && "${2:-}" == -f ]]; then
  exit 0
fi
[[ "${1:-}" == node && "${3:-}" =~ ^(status|provision|cleanup)$ ]] || exit 2
command="${3:-}"

case "$command" in
  status)
    if [[ -f "$state_dir/marker" ]]; then
      marker_count=1
      user_count=1
    else
      marker_count=0
      user_count=0
    fi
    printf '{"ok":true,"markerCount":%s,"userCount":%s,"databaseName":"nav","databaseOid":"16384","databaseServerAddress":"172.20.0.2/32","databaseServerPort":5432,"serverVersionNum":"160010"}\n' \
      "$marker_count" "$user_count"
    ;;
  provision)
    input_file="$state_dir/provision-input.json"
    cat > "$input_file"
    python3 - "$input_file" "$state_dir/secret-value" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
assert len(data['password']) >= 48
assert data['clientIps'] == ['203.0.113.10']
open(sys.argv[2], 'w', encoding='utf-8').write(data['password'])
PY
    : > "$state_dir/marker"
    printf '%s\n' '{"ok":true,"userId":"40000000-0000-4000-8000-000000000001"}'
    ;;
  cleanup)
    cat > "$state_dir/cleanup-input.json"
    if [[ "${NAV_TEST_FAKE_CLEANUP_FAIL:-}" == true ]]; then
      printf '%s\n' 'RELEASE_ACCEPTANCE_ACCOUNT_ERROR|code=INJECTED_CLEANUP_FAILURE' >&2
      exit 70
    fi
    if [[ -f "$state_dir/marker" ]]; then
      rm -f -- "$state_dir/marker"
      printf '%s\n' '{"ok":true,"cleaned":true,"markerMissing":false,"usersRemoved":1,"sessionsRemoved":1,"securityEventsRemoved":1,"rateLimitBucketsRemoved":1}'
    else
      printf '%s\n' '{"ok":true,"cleaned":false,"markerMissing":true,"usersRemoved":0,"sessionsRemoved":0,"securityEventsRemoved":0,"rateLimitBucketsRemoved":0}'
    fi
    ;;
esac
EOF
chmod 700 "$FAKE_BIN/docker"

cat > "$COMMAND" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
test "${NAV_ACCEPTANCE_EPHEMERAL:-}" = true
test -s "${NAV_ACCEPTANCE_USERNAME_FILE:?}"
test -s "${NAV_ACCEPTANCE_PASSWORD_FILE:?}"
if [[ "${NAV_TEST_ACCEPTANCE_BLOCK:-}" == true ]]; then
  trap 'exit 143' TERM
  while :; do sleep 1; done
fi
exit "${NAV_TEST_ACCEPTANCE_EXIT:-0}"
EOF
chmod 700 "$COMMAND"

run_wrapper() {
  local evidence_name="$1"
  shift
  env \
    PATH="$FAKE_BIN:$PATH" \
    NAV_RELEASES_ROOT="$TEST_ROOT/releases" \
    NAV_TEST_FAKE_DOCKER_STATE="$FAKE_STATE" \
    NAV_TEST_RELEASE_SHA="$RELEASE_SHA" \
    "$@" \
    "$WRAPPER" \
      --release-dir "$RELEASE_DIR" \
      --api-container nav-api-test \
      --database-container nav-postgres-test \
      --database-name nav \
      --database-user nav \
      --expected-release-sha "$RELEASE_SHA" \
      --timeout-seconds 30 \
      --client-ip 203.0.113.10 \
      --evidence-file "$RELEASE_DIR/evidence/$evidence_name" \
      -- "$COMMAND"
}

assert_secret_absent() {
  local output_file="$1"
  local evidence_file="$2"
  local secret
  secret="$(<"$FAKE_STATE/secret-value")"
  ! grep -F -- "$secret" "$output_file" "$evidence_file"
}

success_log="$TEST_ROOT/success.log"
run_wrapper success.txt >"$success_log" 2>&1
grep -qx 'status=PASS' "$RELEASE_DIR/evidence/success.txt"
grep -qx 'cleanup=PASS' "$RELEASE_DIR/evidence/success.txt"
[[ ! -e "$FAKE_STATE/marker" && ! -e "$RELEASE_DIR/runtime/release-acceptance" ]]
assert_secret_absent "$success_log" "$RELEASE_DIR/evidence/success.txt"

failure_log="$TEST_ROOT/failure.log"
set +e
run_wrapper failure.txt NAV_TEST_ACCEPTANCE_EXIT=42 >"$failure_log" 2>&1
failure_status="$?"
set -e
[[ "$failure_status" == 42 ]]
grep -qx 'status=FAIL' "$RELEASE_DIR/evidence/failure.txt"
grep -qx 'cleanup=PASS' "$RELEASE_DIR/evidence/failure.txt"
[[ ! -e "$FAKE_STATE/marker" ]]
assert_secret_absent "$failure_log" "$RELEASE_DIR/evidence/failure.txt"

cleanup_failure_log="$TEST_ROOT/cleanup-failure.log"
set +e
run_wrapper cleanup-failure.txt NAV_TEST_FAKE_CLEANUP_FAIL=true >"$cleanup_failure_log" 2>&1
cleanup_failure_status="$?"
set -e
[[ "$cleanup_failure_status" == 70 ]]
grep -qx 'status=FAIL' "$RELEASE_DIR/evidence/cleanup-failure.txt"
grep -qx 'cleanup=FAIL' "$RELEASE_DIR/evidence/cleanup-failure.txt"
[[ -f "$FAKE_STATE/marker" && -f "$RELEASE_DIR/runtime/release-acceptance/state.json" ]]
assert_secret_absent "$cleanup_failure_log" "$RELEASE_DIR/evidence/cleanup-failure.txt"
rm -f -- "$FAKE_STATE/marker"
rm -rf -- "$RELEASE_DIR/runtime/release-acceptance"

signal_log="$TEST_ROOT/signal.log"
env \
  PATH="$FAKE_BIN:$PATH" \
  NAV_RELEASES_ROOT="$TEST_ROOT/releases" \
  NAV_TEST_FAKE_DOCKER_STATE="$FAKE_STATE" \
  NAV_TEST_RELEASE_SHA="$RELEASE_SHA" \
  NAV_TEST_ACCEPTANCE_BLOCK=true \
  setsid "$WRAPPER" \
    --release-dir "$RELEASE_DIR" \
    --api-container nav-api-test \
    --database-container nav-postgres-test \
    --database-name nav \
    --database-user nav \
    --expected-release-sha "$RELEASE_SHA" \
    --timeout-seconds 30 \
    --client-ip 203.0.113.10 \
    --evidence-file "$RELEASE_DIR/evidence/signal.txt" \
    -- "$COMMAND" >"$signal_log" 2>&1 &
signal_pid="$!"
for _ in $(seq 1 100); do
  [[ -f "$FAKE_STATE/marker" ]] && break
  sleep 0.05
done
[[ -f "$FAKE_STATE/marker" ]]
kill -TERM -- "$signal_pid"
set +e
wait "$signal_pid"
signal_status="$?"
set -e
[[ "$signal_status" == 143 ]]
grep -qx 'status=FAIL' "$RELEASE_DIR/evidence/signal.txt"
grep -qx 'cleanup=PASS' "$RELEASE_DIR/evidence/signal.txt"
[[ ! -e "$FAKE_STATE/marker" ]]
assert_secret_absent "$signal_log" "$RELEASE_DIR/evidence/signal.txt"

set +e
run_wrapper noncanonical-lock.txt \
  NAV_BACKUP_LOCK_FILE="$TEST_ROOT/not-canonical.lock" \
  >"$TEST_ROOT/noncanonical-lock.log" 2>&1
noncanonical_lock_status="$?"
set -e
[[ "$noncanonical_lock_status" == 78 ]]
[[ ! -e "$RELEASE_DIR/evidence/noncanonical-lock.txt" && ! -e "$FAKE_STATE/marker" ]]

exec 7>>/run/lock/nav-backup.lock
flock -n 7
set +e
run_wrapper lock-blocked.txt >"$TEST_ROOT/lock-blocked.log" 2>&1
lock_status="$?"
set -e
[[ "$lock_status" == 75 ]]
exec 7>&-

printf '%s\n' 'release acceptance shell lifecycle tests passed'
