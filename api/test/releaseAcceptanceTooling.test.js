import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function readSource(relativeUrl) {
  return (await readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n')
}

test('release acceptance wrapper treats provisioning and cleanup as one lifecycle', async () => {
  const shell = await readSource('../../scripts/release/nav-with-ephemeral-admin.sh')

  assert.match(shell, /set -Eeuo pipefail/)
  assert.match(shell, /set \+x/)
  assert.match(shell, /umask 077/)
  assert.match(shell, /flock -n/)
  assert.match(shell, /\/run\/lock\/nav-release\.lock/)
  assert.match(shell, /\/run\/lock\/nav-backup\.lock/)
  assert.ok(
    shell.indexOf("prepare_lock_file \"$release_lock_file\"")
      < shell.indexOf("prepare_lock_file \"$BACKUP_LOCK_FILE\"")
  )
  assert.match(shell, /org\.opencontainers\.image\.revision/)
  assert.match(shell, /candidate API is not connected to the selected PostgreSQL 16 container/)
  assert.match(shell, /mktemp -d \/run\/nav-release-acceptance\.XXXXXX/)
  assert.match(shell, /trap finalize EXIT/)
  assert.match(shell, /trap 'handle_signal HUP 129' HUP/)
  assert.match(shell, /trap 'handle_signal INT 130' INT/)
  assert.match(shell, /trap 'handle_signal TERM 143' TERM/)
  assert.match(shell, /setsid timeout/)
  assert.match(shell, /--kill-after=5s/)
  assert.match(shell, /run_control\(\)[\s\S]*CONTROL_TIMEOUT_SECONDS/)
  assert.match(shell, /kill -s "\$signal_name" -- "-\$ACCEPTANCE_PID"/)
  assert.match(shell, /NAV_BACKUP_LOCK_FILE must remain/)
  assert.match(shell, /os\.O_NOFOLLOW/)
  assert.match(shell, /exec 9>>"\$release_lock_file"/)
  assert.match(shell, /exec 8>>"\$BACKUP_LOCK_FILE"/)
  assert.match(shell, /cleanup_account/)
  assert.match(shell, /cleanup failed; non-secret marker state was retained/)
  assert.match(shell, /NAV_ACCEPTANCE_USERNAME_FILE/)
  assert.match(shell, /NAV_ACCEPTANCE_PASSWORD_FILE/)
  assert.match(shell, /credential_values=not-recorded/)
  assert.match(shell, /real_admin_credentials=not-read-or-modified/)
  assert.doesNotMatch(shell, /PASSWORD_FILE="\$release_real/)
  assert.doesNotMatch(shell, /nav-admin-(?:username|password)/)
  assert.doesNotMatch(shell, /\beval\b/)
  assert.doesNotMatch(shell, /NAV_ACCEPTANCE_PASSWORD=/)
})

test('release acceptance database helper fails closed and deletes only marker-owned rows', async () => {
  const source = await readSource('../src/ops/releaseAcceptanceAccount.js')

  assert.match(source, /pg_advisory_xact_lock/)
  assert.match(source, /release_acceptance_account:/)
  assert.match(source, /ACCEPTANCE_ACCOUNT_RESIDUE_PRESENT/)
  assert.match(source, /UNTRACKED_ACCEPTANCE_ACCOUNT_RESIDUE/)
  assert.match(source, /EXPECTED_ACCEPTANCE_ACCOUNT_MISSING/)
  assert.match(source, /ACCEPTANCE_MARKER_USER_ID_MISMATCH/)
  assert.match(source, /WHERE id = \$1\s+AND username = \$2/)
  assert.match(source, /actor_user_id = \$1\s+OR subject_user_id = \$1/)
  assert.match(source, /DELETE FROM system_settings WHERE key = \$1/)
  assert.match(source, /authenticated_write/)
  assert.match(source, /ai_requests/)
  assert.match(source, /data_restore/)
  assert.match(source, /auth_login/)
  assert.doesNotMatch(source, /DELETE FROM users[\s\S]{0,120}(?:LIKE|LEFT\(username)/)
})

test('release acceptance CLI never returns a password or password hash', async () => {
  const source = await readSource('../src/ops/releaseAcceptanceAccountCli.js')
  const provisionResult = source.slice(
    source.indexOf('async function provision()'),
    source.indexOf('async function cleanup()')
  )

  assert.match(source, /MAX_STDIN_BYTES/)
  assert.match(source, /RELEASE_ACCEPTANCE_ACCOUNT_ERROR\|code=/)
  assert.match(provisionResult, /userId: result\.userId/)
  assert.doesNotMatch(provisionResult, /return \{[\s\S]*password(?:Hash)?:/)
})

test('candidate API image carries an exact revision label and health probe', async () => {
  const dockerfile = await readSource('../Dockerfile')
  const compose = await readSource('../../docker-compose.backend.yml')

  assert.match(dockerfile, /ARG NAV_RELEASE_SHA=development/)
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision=\$NAV_RELEASE_SHA/)
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*127\.0\.0\.1:3001\/health/)
  assert.match(compose, /NAV_RELEASE_SHA: "\$\{NAV_RELEASE_SHA:-development\}"/)
})
