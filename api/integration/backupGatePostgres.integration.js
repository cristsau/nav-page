import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_release_acceptance_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const POSTGRES_IMAGE = 'postgres:16-alpine'
const CLIENT_IP = '203.0.113.10'
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
)
const BACKUP_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'nav-backup.sh')

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.CI, 'true')
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_BACKUP_GATE_INTEGRATION_TEST, 'true')
  assert.equal(typeof process.getuid, 'function')
  assert.equal(process.getuid(), 0, 'backup integration must run as root in isolated CI')

  let databaseUrl
  try {
    databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  } catch {
    assert.fail('backup gate integration requires a valid DATABASE_URL')
  }
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(
    decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')),
    EXPECTED_DATABASE_NAME
  )
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }
  return databaseUrl
}

const databaseUrl = assertIsolatedDatabaseTarget()

let pool
let provisionReleaseAcceptanceAccount
let fixtureRoot
let fakeBin
let backupRoot
let configPath
let realDocker
let dockerCallLog

function runId(seed) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 48)
}

function username(seed) {
  return `nav_release_accept_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

async function resetAcceptanceResidue() {
  await pool.query(
    `
      DELETE FROM system_settings
      WHERE LEFT(key, LENGTH('release_acceptance_account:')) = 'release_acceptance_account:'
    `
  )
  await pool.query(
    `
      DELETE FROM users
      WHERE LEFT(username, LENGTH('nav_release_accept_')) = 'nav_release_accept_'
    `
  )
}

async function resetBackupRoot() {
  await rm(backupRoot, { recursive: true, force: true })
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await chmod(backupRoot, 0o700)
}

async function completedBackups() {
  const entries = await readdir(backupRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && /^nav-/.test(entry.name))
    .map((entry) => path.join(backupRoot, entry.name))
    .sort()
}

async function dockerCalls() {
  return (await readFile(dockerCallLog, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
}

function startBackup() {
  let stdout = ''
  let stderr = ''
  let settled = false
  const child = spawn('bash', [BACKUP_SCRIPT, '--config', configPath], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      NAV_ACCEPTANCE_EPHEMERAL: 'false',
      NAV_TEST_REAL_DOCKER: realDocker,
      NAV_TEST_POSTGRES_IMAGE: POSTGRES_IMAGE,
      NAV_TEST_DB_HOST: databaseUrl.hostname,
      NAV_TEST_DB_PORT: databaseUrl.port || '5432',
      NAV_TEST_DB_PASSWORD: decodeURIComponent(databaseUrl.password),
      NAV_TEST_DOCKER_CALL_LOG: dockerCallLog
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL'
  })

  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const completion = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      settled = true
      reject(error)
    })
    child.once('close', (code, signal) => {
      settled = true
      resolve({ code, signal, stdout, stderr })
    })
  })

  return {
    child,
    completion,
    isSettled: () => settled
  }
}

async function runBackup() {
  return startBackup().completion
}

async function assertBackupArtifact() {
  const backups = await completedBackups()
  assert.equal(backups.length, 1)
  for (const relativePath of [
    'database/nav.dump',
    'database/snapshot-id.txt',
    'database/public-tables.txt',
    'database/table-counts.tsv',
    'manifest.sha256'
  ]) {
    const details = await stat(path.join(backups[0], relativePath))
    assert.ok(details.isFile())
    assert.ok(details.size > 0)
  }
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForBackupAdvisoryWait(backup, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    assert.equal(backup.isSettled(), false, 'backup exited before reaching the advisory lock')
    const waiting = await pool.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND query LIKE '%nav_release_acceptance_account%'
        ) AS present
      `
    )
    if (waiting.rows[0]?.present === true) return
    await wait(100)
  }
  assert.fail('backup did not become an observable advisory-lock waiter')
}

before(async () => {
  const [databaseModule, acceptanceModule] = await Promise.all([
    import('../src/db/index.js'),
    import('../src/ops/releaseAcceptanceAccount.js')
  ])
  pool = databaseModule.pool
  provisionReleaseAcceptanceAccount = acceptanceModule.provisionReleaseAcceptanceAccount

  const target = await pool.query(
    `
      SELECT
        current_database() AS database_name,
        current_setting('server_version_num') AS server_version_num
    `
  )
  assert.equal(target.rows[0]?.database_name, EXPECTED_DATABASE_NAME)
  assert.match(String(target.rows[0]?.server_version_num || ''), /^16[0-9]{4}$/)

  const dockerLookup = spawnSync('sh', ['-c', 'command -v docker'], {
    encoding: 'utf8'
  })
  assert.equal(dockerLookup.status, 0, dockerLookup.stderr)
  realDocker = dockerLookup.stdout.trim()
  assert.ok(path.isAbsolute(realDocker))
  const imageCheck = spawnSync(realDocker, ['image', 'inspect', POSTGRES_IMAGE], {
    encoding: 'utf8'
  })
  assert.equal(imageCheck.status, 0, `${POSTGRES_IMAGE} must already exist in CI`)

  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'nav-backup-gate-integration-'))
  fakeBin = path.join(fixtureRoot, 'bin')
  backupRoot = path.join(fixtureRoot, 'backups')
  dockerCallLog = path.join(fixtureRoot, 'docker-calls.log')
  const projectDir = path.join(fixtureRoot, 'project')
  const frontendDir = path.join(fixtureRoot, 'frontend')
  configPath = path.join(fixtureRoot, 'nav-backup.env')
  await Promise.all([
    mkdir(fakeBin, { recursive: true, mode: 0o700 }),
    mkdir(backupRoot, { recursive: true, mode: 0o700 }),
    mkdir(projectDir, { recursive: true, mode: 0o700 }),
    mkdir(frontendDir, { recursive: true, mode: 0o700 })
  ])
  await Promise.all([
    writeFile(path.join(projectDir, 'PROJECT.txt'), 'backup integration fixture\n', { mode: 0o600 }),
    writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>NAV integration</title>\n', { mode: 0o600 }),
    writeFile(dockerCallLog, '', { mode: 0o600 })
  ])

  const dockerStub = `#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\\n\\t'

real_docker="\${NAV_TEST_REAL_DOCKER:?}"
postgres_image="\${NAV_TEST_POSTGRES_IMAGE:?}"
database_host="\${NAV_TEST_DB_HOST:?}"
database_port="\${NAV_TEST_DB_PORT:?}"
database_password="\${NAV_TEST_DB_PASSWORD:?}"
call_log="\${NAV_TEST_DOCKER_CALL_LOG:?}"

case "\${1:-}" in
  version)
    printf '%s\\n' 'postgres-16-integration'
    ;;
  inspect)
    shift
    if [[ "\${1:-}" == --format ]]; then
      container="\${3:-}"
      printf '/%s\\tpostgres:16-alpine\\tsha256:integration\\trunning\\n' "$container"
    else
      printf '%s\\n' '[]'
    fi
    ;;
  exec)
    shift
    interactive=false
    if [[ "\${1:-}" == -i ]]; then
      interactive=true
      shift
    fi
    container="\${1:-}"
    shift
    [[ "$container" == nav-postgres-integration ]] || exit 2
    database_command="\${1:-}"
    shift
    printf '%s\\n' "$database_command" >> "$call_log"
    run_args=(run --rm --pull=never --network host -e "PGPASSWORD=$database_password")
    "$interactive" && run_args+=(-i)
    case "$database_command" in
      psql|pg_dump)
        exec "$real_docker" "\${run_args[@]}" "$postgres_image" \
          "$database_command" -h "$database_host" -p "$database_port" "$@"
        ;;
      pg_restore)
        exec "$real_docker" "\${run_args[@]}" "$postgres_image" pg_restore "$@"
        ;;
      *)
        exit 2
        ;;
    esac
    ;;
  *)
    exit 2
    ;;
esac
`
  const dockerStubPath = path.join(fakeBin, 'docker')
  await writeFile(dockerStubPath, dockerStub, { mode: 0o700 })
  await chmod(dockerStubPath, 0o700)

  const config = [
    `NAV_BACKUP_ROOT=${backupRoot}`,
    'NAV_BACKUP_LOCK_FILE=/run/lock/nav-backup.lock',
    'NAV_DB_CONTAINER=nav-postgres-integration',
    `NAV_DB_NAME=${EXPECTED_DATABASE_NAME}`,
    `NAV_DB_USER=${decodeURIComponent(databaseUrl.username)}`,
    'NAV_PG_SNAPSHOT_TIMEOUT_SECONDS=30',
    `NAV_PROJECT_DIR=${projectDir}`,
    `NAV_FRONTEND_DIR=${frontendDir}`,
    'NAV_COMPOSE_PATHS=',
    'NAV_NGINX_PATHS=',
    'NAV_ENV_PATHS=',
    'NAV_EXTRA_CONFIG_PATHS=',
    'NAV_RUNTIME_CONTAINERS=nav-postgres-integration',
    'NAV_REQUIRE_ALL_INPUTS=true',
    'NAV_ENABLE_LOCAL_PRUNE=false',
    'NAV_ENABLE_TELEGRAM_ALERTS=false',
    'NAV_ENABLE_CLOUD_UPLOAD=false',
    'NAV_ENABLE_RESTIC_FORGET=false',
    'NAV_DRY_RUN=false',
    ''
  ].join('\n')
  await writeFile(configPath, config, { mode: 0o600 })
  await chmod(configPath, 0o600)
})

beforeEach(async () => {
  await resetAcceptanceResidue()
  await resetBackupRoot()
  await writeFile(dockerCallLog, '', { mode: 0o600 })
})

after(async () => {
  if (pool) {
    await resetAcceptanceResidue().catch(() => {})
    await pool.end()
  }
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('canonical backup completes against a clean PostgreSQL 16 snapshot', async () => {
  const result = await runBackup()
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.match(result.stderr, /backup workflow complete/)
  assert.ok((await dockerCalls()).includes('pg_dump'))
  await assertBackupArtifact()
})

test('canonical backup rejects release-acceptance marker residue before pg_dump', async () => {
  await pool.query(
    `
      INSERT INTO system_settings (key, value)
      VALUES ($1, $2::jsonb)
    `,
    [`release_acceptance_account:${runId('marker-residue')}`, JSON.stringify({ test: true })]
  )

  const result = await runBackup()
  assert.equal(result.code, 75, result.stderr)
  assert.match(result.stderr, /release acceptance residue blocks database backup/)
  assert.equal((await dockerCalls()).includes('pg_dump'), false)
  assert.deepEqual(await completedBackups(), [])
})

test('canonical backup rejects prefix-user residue before pg_dump', async () => {
  await pool.query(
    `
      INSERT INTO users (username, password_hash, role, status, approved_at)
      VALUES ($1, 'integration-only', 'admin', 'approved', NOW())
    `,
    [username('user-residue')]
  )

  const result = await runBackup()
  assert.equal(result.code, 75, result.stderr)
  assert.match(result.stderr, /release acceptance residue blocks database backup/)
  assert.equal((await dockerCalls()).includes('pg_dump'), false)
  assert.deepEqual(await completedBackups(), [])
})

test('canonical backup waits behind the provision advisory transaction', async () => {
  const client = await pool.connect()
  let backup
  let observationError
  await client.query('BEGIN')
  try {
    await provisionReleaseAcceptanceAccount(client, {
      runId: runId('concurrent-provision'),
      username: username('concurrent-provision'),
      passwordHash: `scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}`,
      clientIps: [CLIENT_IP]
    })

    backup = startBackup()
    await waitForBackupAdvisoryWait(backup)
    assert.equal(backup.isSettled(), false, 'backup crossed the advisory gate while provision was open')
    assert.equal((await dockerCalls()).includes('pg_dump'), false)
    assert.deepEqual(await completedBackups(), [])
  } catch (error) {
    observationError = error
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }

  if (!backup) throw observationError
  const result = await backup.completion
  if (observationError) throw observationError
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.ok((await dockerCalls()).includes('pg_dump'))
  await assertBackupArtifact()
})
