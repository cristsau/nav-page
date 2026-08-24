import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')
const bashProbe = spawnSync('bash', ['--version'], { encoding: 'utf8' })
const hasBash = bashProbe.status === 0

const scriptFiles = [
  'scripts/nav-backup.sh',
  'scripts/nav-restore-rehearsal.sh',
  'scripts/nav-restore-latest.sh',
  'scripts/nav-restore-cloud-latest.sh',
  'scripts/nav-heartbeat.sh',
  'scripts/nav-job-failure-notify.sh',
  'scripts/install-nav-backup-systemd.sh'
]

const serviceFiles = [
  'ops/systemd/nav-backup.service',
  'ops/systemd/nav-backup-retention.service',
  'ops/systemd/nav-restore-rehearsal.service'
]

test('backup automation shell scripts pass bash syntax validation when bash is available', async (t) => {
  if (!hasBash) {
    t.skip('bash is not installed on this host; GitHub CI performs this gate')
    return
  }

  for (const relativePath of scriptFiles) {
    const result = spawnSync('bash', ['-n', path.join(root, relativePath)], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${relativePath}: ${result.stderr}`)
  }
})

test('backup snapshot fails closed around release acceptance residue', async () => {
  const backup = await read('scripts/nav-backup.sh')
  const gate = backup.indexOf("hashtext('nav_release_acceptance_account')")
  const markerCheck = backup.indexOf('release_acceptance_account:')
  const userCheck = backup.indexOf('nav_release_accept_')
  const dump = backup.indexOf('pg_dump -U')

  assert.ok(gate >= 0 && markerCheck >= 0 && userCheck >= 0)
  assert.ok(gate < dump && markerCheck < dump && userCheck < dump)
  assert.match(backup, /release acceptance residue blocks database backup/)
  assert.match(backup, /backup must run outside the release acceptance lifecycle/)
  assert.match(backup, /CANONICAL_BACKUP_LOCK_FILE='\/run\/lock\/nav-backup\.lock'/)
  assert.match(backup, /NAV_BACKUP_LOCK_FILE must remain/)
  assert.match(backup, /os\.O_NOFOLLOW/)
  assert.match(backup, /exec 9>>"\$NAV_BACKUP_LOCK_FILE"/)
  assert.doesNotMatch(backup, /exec 9>"\$NAV_BACKUP_LOCK_FILE"/)
})
test('systemd schedules separate daily backup, weekly retention, and exact cloud restore', async () => {
  const daily = await read('ops/systemd/nav-backup.service')
  const retention = await read('ops/systemd/nav-backup-retention.service')
  const restore = await read('ops/systemd/nav-restore-rehearsal.service')
  const dailyTimer = await read('ops/systemd/nav-backup.timer')
  const retentionTimer = await read('ops/systemd/nav-backup-retention.timer')
  const restoreTimer = await read('ops/systemd/nav-restore-rehearsal.timer')

  assert.match(daily, /ExecStart=.*nav-backup .*--cloud-upload$/m)
  assert.doesNotMatch(daily, /--prune-local|--forget-cloud/)
  assert.match(retention, /--cloud-upload --prune-local --forget-cloud/)
  assert.match(restore, /ExecStart=.*nav-restore-cloud-latest .*nav-backup\.env --cloud-restore$/m)
  assert.match(restore, /Wants=network-online\.target/)
  assert.match(restore, /^ReadWritePaths=.*\/var\/backups\/nav-cloud-restore/m)
  assert.match(daily, /ExecStartPost=.*nav-heartbeat .* backup$/m)
  assert.match(retention, /ExecStartPost=.*nav-heartbeat .* backup$/m)
  assert.match(restore, /ExecStartPost=.*nav-heartbeat .* restore$/m)

  for (const content of [daily, retention, restore]) {
    assert.match(content, /OnFailure=nav-scheduled-failure@%n\.service/)
    assert.match(content, /^Environment=RESTIC_CACHE_DIR=\/var\/cache\/nav-restic$/m)
    assert.match(content, /^CacheDirectory=nav-restic$/m)
    assert.match(content, /^CacheDirectoryMode=0700$/m)
    assert.match(content, /^ReadWritePaths=.*\/var\/cache\/nav-restic/m)
    assert.match(content, /ProtectSystem=strict/)
    assert.match(content, /NoNewPrivileges=true/)
    assert.match(content, /UMask=0077/)
    assert.doesNotMatch(content, /^Environment(?:File)?=.*(?:TOKEN|PASSWORD|KEY|HEARTBEAT_URL)/mi)
  }

  assert.match(dailyTimer, /OnCalendar=\*-\*-\* 03:17:00 UTC/)
  assert.match(retentionTimer, /OnCalendar=Sun \*-\*-\* 05:17:00 UTC/)
  assert.match(restoreTimer, /OnCalendar=Wed \*-\*-\* 04:47:00 UTC/)
  for (const content of [dailyTimer, retentionTimer, restoreTimer]) {
    assert.match(content, /Persistent=true/)
    assert.match(content, /RandomizedDelaySec=/)
  }
})

test('restore rehearsal shares the canonical backup lock before reading a backup', async () => {
  const restore = await read('scripts/nav-restore-rehearsal.sh')
  const canonicalLock = restore.indexOf("CANONICAL_BACKUP_LOCK_FILE='/run/lock/nav-backup.lock'")
  const backupLock = restore.indexOf('flock -n "$BACKUP_LOCK_FD"')
  const backupValidation = restore.indexOf('backup must be a regular directory')

  assert.ok(canonicalLock >= 0 && backupLock >= 0 && backupValidation >= 0)
  assert.ok(backupLock < backupValidation)
  assert.match(restore, /NAV_BACKUP_LOCK_FILE must remain/)
  assert.match(restore, /exec 8>>"\$NAV_BACKUP_LOCK_FILE"/)
  assert.match(restore, /--backup-root/)
  assert.match(restore, /exec 9>>"\$NAV_RESTORE_LOCK_FILE"/)
})

test('isolated restore waits for the final PostgreSQL postmaster', async () => {
  const restore = await read('scripts/nav-restore-rehearsal.sh')

  assert.match(restore, /pg_isready -U nav_rehearsal -d nav_rehearsal/)
  assert.match(restore, /cat \/proc\/1\/comm/)
  assert.match(restore, /final postmaster did not become ready/)
  assert.ok(
    restore.indexOf('cat /proc/1/comm') < restore.indexOf('isolated database restore')
  )
})

test('cloud restore is double-gated, uses the bounded backup root, and restores an exact snapshot id', async () => {
  const cloudRestore = await read('scripts/nav-restore-cloud-latest.sh')
  const example = await read('scripts/nav-backup.env.example')
  const offsiteExample = await read('scripts/restic-offsite.env.example')

  assert.match(cloudRestore, /--cloud-restore is mandatory/)
  assert.match(cloudRestore, /NAV_ENABLE_CLOUD_RESTORE_REHEARSAL=true/)
  assert.match(cloudRestore, /NAV_CLOUD_RESTORE_ROOT:=\/var\/backups\/nav-cloud-restore/)
  assert.match(cloudRestore, /restic restore "\$snapshot_id"/)
  assert.doesNotMatch(cloudRestore, /restic restore latest/)
  assert.match(example, /^NAV_ENABLE_CLOUD_RESTORE_REHEARSAL=false$/m)
  assert.match(example, /^NAV_CLOUD_RESTORE_ROOT=\/var\/backups\/nav-cloud-restore$/m)
  assert.match(example, /^NAV_RESTIC_CACHE_DIR=\/var\/cache\/nav-restic$/m)
  assert.match(example, /^NAV_RESTIC_ENV_FILE=\/etc\/nav\/restic-offsite\.env$/m)
  assert.match(offsiteExample, /^RESTIC_REPOSITORY=s3:https:\/\/REPLACE_WITH_S3_ENDPOINT\//m)
  assert.match(offsiteExample, /^RESTIC_PASSWORD_FILE=\/etc\/nav\/restic-password$/m)
  assert.doesNotMatch(offsiteExample, /cloudflarestorage\.com|[0-9a-f]{32,}/i)
})

test('installer deploys units but cannot enable or start them', async () => {
  const installer = await read('scripts/install-nav-backup-systemd.sh')
  assert.match(installer, /nav-restore-cloud-latest\.sh/)
  assert.match(installer, /\/var\/backups\/nav-cloud-restore/)
  assert.match(installer, /systemctl daemon-reload/)
  assert.doesNotMatch(installer, /systemctl\s+(?:enable|start|restart|reload)\b/)
  assert.match(installer, /without enabling or starting any timer/)
})

test('heartbeat keeps its bearer URL out of curl argv', { skip: !hasBash }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'nav-heartbeat-test-'))
  const binDir = path.join(tempRoot, 'bin')
  const configPath = path.join(tempRoot, 'heartbeat.env')
  const argsPath = path.join(tempRoot, 'curl.args')
  const stdinPath = path.join(tempRoot, 'curl.stdin')
  const curlPath = path.join(binDir, 'curl')
  const secretUrl = 'https://heartbeat.example.test/ping/private-test-id'
  await mkdir(binDir)
  await writeFile(configPath, [
    `NAV_BACKUP_HEARTBEAT_URL=${secretUrl}`,
    'NAV_RESTORE_HEARTBEAT_URL=https://heartbeat.example.test/ping/restore-test-id',
    'NAV_HEARTBEAT_TIMEOUT_SECONDS=10',
    ''
  ].join('\n'), { mode: 0o600 })
  await chmod(configPath, 0o600)
  await writeFile(curlPath, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$NAV_TEST_CURL_ARGS"',
    'cat > "$NAV_TEST_CURL_STDIN"',
    'exit 0',
    ''
  ].join('\n'), { mode: 0o700 })
  await chmod(curlPath, 0o700)

  const result = spawnSync('bash', [
    path.join(root, 'scripts/nav-heartbeat.sh'),
    '--config',
    configPath,
    'backup'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      NAV_TEST_CURL_ARGS: argsPath,
      NAV_TEST_CURL_STDIN: stdinPath
    }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(await readFile(argsPath, 'utf8'), /private-test-id/)
  assert.match(await readFile(argsPath, 'utf8'), /^\-q$/m)
  assert.match(await readFile(stdinPath, 'utf8'), /private-test-id/)
})

test('heartbeat rejects a non-HTTPS endpoint before invoking curl', { skip: !hasBash }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'nav-heartbeat-http-test-'))
  const binDir = path.join(tempRoot, 'bin')
  const configPath = path.join(tempRoot, 'heartbeat.env')
  const markerPath = path.join(tempRoot, 'curl-ran')
  const curlPath = path.join(binDir, 'curl')
  await mkdir(binDir)
  await writeFile(configPath, [
    'NAV_BACKUP_HEARTBEAT_URL=http://heartbeat.example.test/insecure',
    'NAV_RESTORE_HEARTBEAT_URL=https://heartbeat.example.test/restore',
    ''
  ].join('\n'), { mode: 0o600 })
  await chmod(configPath, 0o600)
  await writeFile(curlPath, [
    '#!/usr/bin/env bash',
    `touch '${markerPath}'`,
    'exit 0',
    ''
  ].join('\n'), { mode: 0o700 })
  await chmod(curlPath, 0o700)

  const result = spawnSync('bash', [
    path.join(root, 'scripts/nav-heartbeat.sh'),
    '--config',
    configPath,
    'backup'
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  })
  assert.equal(result.status, 78)
  assert.match(result.stderr, /must use HTTPS/)
  const marker = spawnSync('test', ['-e', markerPath])
  assert.notEqual(marker.status, 0)
})

test('latest-backup selector passes one recent bounded path to the isolated rehearsal', { skip: !hasBash }, async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'nav-restore-latest-test-'))
  const backupRoot = path.join(tempRoot, 'backups')
  const older = path.join(backupRoot, 'nav-20260822T010000Z-old')
  const newest = path.join(backupRoot, 'nav-20260823T010000Z-new')
  const configPath = path.join(tempRoot, 'nav-backup.env')
  const restorePath = path.join(tempRoot, 'restore-stub')
  const argsPath = path.join(tempRoot, 'restore.args')
  await mkdir(older, { recursive: true })
  await mkdir(newest)
  const now = new Date()
  await utimes(older, new Date(now.getTime() - 3600_000), new Date(now.getTime() - 3600_000))
  await utimes(newest, now, now)
  await writeFile(restorePath, [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$@" > "$NAV_TEST_RESTORE_ARGS"',
    'exit 0',
    ''
  ].join('\n'), { mode: 0o700 })
  await chmod(restorePath, 0o700)
  await writeFile(configPath, [
    `NAV_BACKUP_ROOT=${backupRoot}`,
    `NAV_RESTORE_SCRIPT=${restorePath}`,
    'NAV_REHEARSAL_MAX_BACKUP_AGE_HOURS=48',
    ''
  ].join('\n'), { mode: 0o600 })
  await chmod(configPath, 0o600)

  const result = spawnSync('bash', [
    path.join(root, 'scripts/nav-restore-latest.sh'),
    '--config',
    configPath
  ], {
    encoding: 'utf8',
    env: { ...process.env, NAV_TEST_RESTORE_ARGS: argsPath }
  })
  assert.equal(result.status, 0, result.stderr)
  const args = await readFile(argsPath, 'utf8')
  assert.match(args, new RegExp(`--backup\\n${newest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
  assert.match(args, /--run-isolated/)
  assert.doesNotMatch(args, /nav-20260822T010000Z-old/)
})
