import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_release_acceptance_test'
const EXPECTED_HEADER = 'id,user_id,account_id,email_message_id,status,attempt_count,max_attempts,notification_eligible,next_attempt_at,started_at,completed_at,last_error_at,last_error_code,created_at,updated_at'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const USER_ID = '10000000-0000-4000-8000-000000000091'
const ACCOUNT_ID = '20000000-0000-4000-8000-000000000091'
const MESSAGE_ID = '30000000-0000-4000-8000-000000000091'
const JOB_ID = '40000000-0000-4000-8000-000000000091'
const scriptPath = path.resolve(import.meta.dirname, '../../scripts/nav-release-mail-backlog-guard.sh')

let validatedContainer
let databaseUser
let temporaryDirectory
let fixtureSeeded = false

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
    ...options
  })
}

function requireSuccess(result, context) {
  assert.equal(
    result.status,
    0,
    `${context} failed (status=${result.status}, signal=${result.signal || 'none'}): ${result.stderr || result.stdout}`
  )
}

function runPsql(sql) {
  assert.ok(validatedContainer, 'PostgreSQL container must pass identity validation before use')
  const result = run('docker', [
    'exec', '-i', validatedContainer,
    'psql', '-X', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--quiet',
    '--username', databaseUser, '--dbname', EXPECTED_DATABASE_NAME,
    '--command', sql
  ])
  requireSuccess(result, 'PostgreSQL fixture command')
  return result
}

function runGuard(mode, file) {
  const fileFlag = mode === 'snapshot' ? '--output' : '--expected'
  return run('bash', [
    scriptPath,
    mode,
    '--container', validatedContainer,
    '--database', EXPECTED_DATABASE_NAME,
    '--user', databaseUser,
    fileFlag, file
  ])
}

function assertIsolatedPostgres16Target() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_RELEASE_BACKLOG_GUARD_INTEGRATION_TEST, 'true')

  let databaseUrl
  try {
    databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  } catch {
    assert.fail('release backlog guard integration requires a valid DATABASE_URL')
  }
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')), EXPECTED_DATABASE_NAME)
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }

  const candidateDatabaseUser = decodeURIComponent(databaseUrl.username)
  assert.equal(candidateDatabaseUser, 'nav')
  const candidateContainer = String(process.env.NAV_RELEASE_BACKLOG_POSTGRES_CONTAINER || '')
  assert.match(candidateContainer, /^[a-f0-9]{12,64}$/)

  const inspected = run('docker', ['inspect', '--format', '{{.Config.Image}}', candidateContainer])
  requireSuccess(inspected, 'PostgreSQL container inspection')
  assert.equal(inspected.stdout.trim(), 'postgres:16-alpine')
  const identity = run('docker', [
    'exec', '-i', candidateContainer,
    'psql', '-X', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align',
    '--username', candidateDatabaseUser, '--dbname', EXPECTED_DATABASE_NAME,
    '--command', "SELECT current_database() || '|' || current_user || '|' || current_setting('server_version_num');"
  ])
  requireSuccess(identity, 'PostgreSQL container identity validation')
  assert.match(identity.stdout.trim(), /^nav_release_acceptance_test\|nav\|16\d{4}$/)

  databaseUser = candidateDatabaseUser
  validatedContainer = candidateContainer
}

async function resetFixture() {
  runPsql(`
    TRUNCATE TABLE users RESTART IDENTITY CASCADE;
    INSERT INTO users (id, username, password_hash, role, status, approved_at)
    VALUES ('${USER_ID}', 'release-backlog-guard', 'not-a-real-password', 'user', 'approved', NOW());
    INSERT INTO email_accounts (id, user_id, source_key, label)
    VALUES ('${ACCOUNT_ID}', '${USER_ID}', 'release-backlog-guard', 'Release backlog guard');
    INSERT INTO email_messages (
      id, account_id, user_id, canonical_hash, message_id_hash, thread_key_hash,
      envelope_encrypted, content_encrypted, received_at, size_bytes
    ) VALUES (
      '${MESSAGE_ID}', '${ACCOUNT_ID}', '${USER_ID}', REPEAT('a', 64), REPEAT('b', 64), REPEAT('c', 64),
      DECODE(REPEAT('aa', 32), 'hex'), DECODE(REPEAT('bb', 32), 'hex'),
      '2026-09-01T00:00:00.000000Z', 64
    );
    INSERT INTO email_classification_jobs (
      id, user_id, account_id, email_message_id, status, attempt_count, max_attempts,
      notification_eligible, next_attempt_at, started_at, completed_at,
      last_error_at, last_error_code, created_at, updated_at
    ) VALUES (
      '${JOB_ID}', '${USER_ID}', '${ACCOUNT_ID}', '${MESSAGE_ID}', 'retry_wait', 1, 5,
      TRUE, '2026-09-01T00:05:00.000000Z', '2026-09-01T00:01:00.000000Z', NULL,
      '2026-09-01T00:02:00.000000Z', 'TEMPFAIL',
      '2026-09-01T00:00:00.000000Z', '2026-09-01T00:02:00.000000Z'
    );
  `)
}

before(async () => {
  assertIsolatedPostgres16Target()
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-release-backlog-pg16-'))
  await resetFixture()
  fixtureSeeded = true
})

after(async () => {
  try {
    if (fixtureSeeded) runPsql('TRUNCATE TABLE users RESTART IDENTITY CASCADE;')
  } finally {
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
})

test('real PostgreSQL 16 snapshot has the exact header, verifies unchanged data and fails on lifecycle drift', async () => {
  const snapshot = path.join(temporaryDirectory, 'retained-jobs-before.csv')
  const captured = runGuard('snapshot', snapshot)
  requireSuccess(captured, 'backlog snapshot')
  assert.match(captured.stdout, /BACKLOG_SNAPSHOT_STATUS=CAPTURED/)
  assert.match(captured.stdout, /BACKLOG_SNAPSHOT_ROWS=1/)

  const contents = await fs.readFile(snapshot, 'utf8')
  assert.equal(contents.split('\n', 1)[0], EXPECTED_HEADER)
  assert.equal((await fs.readFile(`${snapshot}.count`, 'utf8')).trim(), '1')

  const verified = runGuard('verify', snapshot)
  requireSuccess(verified, 'unchanged backlog verification')
  assert.match(verified.stdout, /BACKLOG_SNAPSHOT_STATUS=MATCH/)

  runPsql(`
    UPDATE email_classification_jobs
    SET attempt_count = 2, updated_at = '2026-09-01T00:03:00.000000Z'
    WHERE id = '${JOB_ID}';
  `)
  const diverged = runGuard('verify', snapshot)
  assert.equal(diverged.status, 75, diverged.stderr)
  assert.match(diverged.stderr, /backlog diverged \(expected_rows=1, current_rows=1\)/)
  assert.match(diverged.stderr, /repeat preflight before switching/)
})
