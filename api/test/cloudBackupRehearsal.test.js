import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const cloudRestoreScript = path.join(root, 'scripts', 'nav-restore-cloud-latest.sh')
const bashAvailable = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
const jqAvailable = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0
const canExerciseShell = bashAvailable && jqAvailable
const snapshotId = 'a'.repeat(64)
const snapshotPath = '/var/backups/nav/nav-20260824T010203Z-25c9c13'

async function secureWrite(file, contents, mode = 0o600) {
  await writeFile(file, contents, { mode })
  await chmod(file, mode)
}

async function createFixture({ enabled = true, metadata } = {}) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'nav-cloud-rehearsal-test-'))
  const fakeBin = path.join(fixtureRoot, 'bin')
  const cloudRoot = path.join(fixtureRoot, 'cloud-restore')
  const cacheDir = path.join(fixtureRoot, 'restic-cache')
  const configPath = path.join(fixtureRoot, 'nav-backup.env')
  const resticEnvPath = path.join(fixtureRoot, 'restic.env')
  const passwordPath = path.join(fixtureRoot, 'restic-password')
  const metadataPath = path.join(fixtureRoot, 'snapshot.json')
  const resticLog = path.join(fixtureRoot, 'restic.log')
  const restoreLog = path.join(fixtureRoot, 'restore.log')
  const resticPath = path.join(fakeBin, 'restic')
  const restorePath = path.join(fixtureRoot, 'restore-stub')

  await mkdir(fakeBin, { recursive: true, mode: 0o700 })
  await secureWrite(passwordPath, 'test-only-restic-password\n')
  await secureWrite(resticEnvPath, [
    'RESTIC_REPOSITORY=s3:https://objects.example.test/nav-backup',
    `RESTIC_PASSWORD_FILE=${passwordPath}`,
    'AWS_ACCESS_KEY_ID=ci-test-key-id',
    'AWS_SECRET_ACCESS_KEY=ci-test-secret-value',
    'AWS_DEFAULT_REGION=auto',
    ''
  ].join('\n'))
  await secureWrite(configPath, [
    `NAV_ENABLE_CLOUD_RESTORE_REHEARSAL=${enabled ? 'true' : 'false'}`,
    `NAV_RESTIC_ENV_FILE=${resticEnvPath}`,
    'NAV_RESTIC_TAG=domo-nav',
    `NAV_RESTIC_CACHE_DIR=${cacheDir}`,
    `NAV_CLOUD_RESTORE_ROOT=${cloudRoot}`,
    'NAV_CLOUD_REHEARSAL_MAX_SNAPSHOT_AGE_HOURS=48',
    `NAV_RESTORE_SCRIPT=${restorePath}`,
    ''
  ].join('\n'))
  await secureWrite(
    metadataPath,
    JSON.stringify(metadata ?? [{
      id: snapshotId,
      time: new Date().toISOString(),
      tags: ['domo-nav'],
      paths: [snapshotPath]
    }]) + '\n'
  )

  await secureWrite(resticPath, `#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\\n\\t'
{
  printf 'BEGIN\\n'
  printf 'CACHE=%s\\n' "\${RESTIC_CACHE_DIR:-}"
  for argument in "$@"; do
    printf 'ARG=%s\\n' "$argument"
  done
  printf 'END\\n'
} >> "\${NAV_TEST_RESTIC_LOG:?}"

case "\${1:-}" in
  snapshots)
    cat "\${NAV_TEST_RESTIC_METADATA:?}"
    ;;
  restore)
    shift
    snapshot="\${1:-}"
    shift
    target=""
    include=""
    while (($#)); do
      case "$1" in
        --target)
          target="\${2:-}"
          shift 2
          ;;
        --include)
          include="\${2:-}"
          shift 2
          ;;
        *)
          exit 91
          ;;
      esac
    done
    [[ "$snapshot" == "\${NAV_TEST_EXPECTED_SNAPSHOT:?}" ]]
    [[ "$include" == "\${NAV_TEST_EXPECTED_PATH:?}" ]]
    [[ -n "$target" ]]
    mkdir -p -- "$target/\${include#/}"
    printf 'restored fixture\\n' > "$target/\${include#/}/fixture.txt"
    ;;
  *)
    exit 92
    ;;
esac
`, 0o700)

  await secureWrite(restorePath, `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$@" > "\${NAV_TEST_RESTORE_LOG:?}"
backup_root=""
backup=""
while (($#)); do
  case "$1" in
    --config)
      [[ "\${2:-}" == "\${NAV_TEST_EXPECTED_CONFIG:?}" ]]
      shift 2
      ;;
    --backup-root)
      backup_root="\${2:-}"
      shift 2
      ;;
    --backup)
      backup="\${2:-}"
      shift 2
      ;;
    --run-isolated)
      shift
      ;;
    *)
      exit 93
      ;;
  esac
done
[[ -n "$backup_root" && -n "$backup" ]]
[[ "$backup_root" == "$(dirname "$backup")" ]]
[[ -d "$backup" && ! -L "$backup" ]]
[[ -f "$backup/fixture.txt" ]]
`, 0o700)

  const run = (args, env = {}) => spawnSync('bash', [cloudRestoreScript, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CI: 'true',
      NODE_ENV: 'test',
      NAV_CLOUD_RESTORE_REHEARSAL_TEST: 'true',
      NAV_TEST_RESTIC_METADATA: metadataPath,
      NAV_TEST_RESTIC_LOG: resticLog,
      NAV_TEST_RESTORE_LOG: restoreLog,
      NAV_TEST_EXPECTED_SNAPSHOT: snapshotId,
      NAV_TEST_EXPECTED_PATH: snapshotPath,
      NAV_TEST_EXPECTED_CONFIG: configPath,
      ...env
    }
  })

  return {
    fixtureRoot,
    cloudRoot,
    cacheDir,
    configPath,
    resticLog,
    restoreLog,
    run
  }
}

async function removeFixture(fixture) {
  await rm(fixture.fixtureRoot, { recursive: true, force: true })
}

test('cloud rehearsal selects one exact tagged snapshot, forwards bounded restore arguments, and cleans plaintext', { skip: !canExerciseShell }, async () => {
  const fixture = await createFixture()
  try {
    const result = fixture.run(['--config', fixture.configPath, '--cloud-restore'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /cloud restore rehearsal passed for exact snapshot a{12}/)

    const resticCalls = await readFile(fixture.resticLog, 'utf8')
    assert.match(resticCalls, /ARG=snapshots\nARG=--tag\nARG=domo-nav\nARG=--latest\nARG=1\nARG=--json/)
    assert.match(resticCalls, new RegExp(`ARG=restore\\nARG=${snapshotId}`))
    assert.match(resticCalls, new RegExp(`ARG=--include\\nARG=${snapshotPath}`))
    assert.match(resticCalls, new RegExp(`CACHE=${fixture.cacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.doesNotMatch(resticCalls, /ci-test-secret-value|test-only-restic-password/)

    const restoreArguments = (await readFile(fixture.restoreLog, 'utf8')).trim().split(/\r?\n/)
    assert.deepEqual(restoreArguments.slice(0, 2), ['--config', fixture.configPath])
    const rootIndex = restoreArguments.indexOf('--backup-root')
    const backupIndex = restoreArguments.indexOf('--backup')
    assert.ok(rootIndex >= 0 && backupIndex >= 0)
    assert.equal(restoreArguments.at(-1), '--run-isolated')
    assert.equal(path.dirname(restoreArguments[backupIndex + 1]), restoreArguments[rootIndex + 1])
    assert.equal(path.basename(restoreArguments[backupIndex + 1]), path.basename(snapshotPath))
    assert.equal(existsSync(restoreArguments[backupIndex + 1]), false)

    assert.deepEqual(await readdir(fixture.cloudRoot), [])
    assert.equal((await stat(fixture.cloudRoot)).mode & 0o777, 0o700)
    assert.equal((await stat(fixture.cacheDir)).mode & 0o777, 0o700)
  } finally {
    await removeFixture(fixture)
  }
})

test('cloud rehearsal refuses execution unless both CLI and config gates are present', { skip: !canExerciseShell }, async () => {
  const cliFixture = await createFixture()
  try {
    const withoutCliGate = cliFixture.run(['--config', cliFixture.configPath])
    assert.equal(withoutCliGate.status, 64, withoutCliGate.stderr)
    assert.equal(existsSync(cliFixture.resticLog), false)
    assert.equal(existsSync(cliFixture.restoreLog), false)
  } finally {
    await removeFixture(cliFixture)
  }

  const configFixture = await createFixture({ enabled: false })
  try {
    const withoutConfigGate = configFixture.run([
      '--config',
      configFixture.configPath,
      '--cloud-restore'
    ])
    assert.equal(withoutConfigGate.status, 78, withoutConfigGate.stderr)
    assert.match(withoutConfigGate.stderr, /NAV_ENABLE_CLOUD_RESTORE_REHEARSAL=true/)
    assert.equal(existsSync(configFixture.resticLog), false)
    assert.equal(existsSync(configFixture.restoreLog), false)
  } finally {
    await removeFixture(configFixture)
  }
})

test('cloud rehearsal rejects stale or malformed snapshot metadata before restore', { skip: !canExerciseShell }, async (t) => {
  const cases = [
    {
      name: 'stale snapshot',
      metadata: [{
        id: snapshotId,
        time: '2000-01-01T00:00:00.000Z',
        tags: ['domo-nav'],
        paths: [snapshotPath]
      }],
      message: /stale or has an invalid timestamp/
    },
    {
      name: 'ambiguous paths',
      metadata: [{
        id: snapshotId,
        time: new Date().toISOString(),
        tags: ['domo-nav'],
        paths: [snapshotPath, '/var/backups/nav/nav-20260824T020304Z-other']
      }],
      message: /metadata is malformed or ambiguous/
    },
    {
      name: 'malformed snapshot id',
      metadata: [{
        id: 'not-a-snapshot-id',
        time: new Date().toISOString(),
        tags: ['domo-nav'],
        paths: [snapshotPath]
      }],
      message: /metadata is malformed or ambiguous/
    }
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = await createFixture({ metadata: scenario.metadata })
      try {
        const result = fixture.run(['--config', fixture.configPath, '--cloud-restore'])
        assert.equal(result.status, 80, result.stderr)
        assert.match(result.stderr, scenario.message)
        assert.equal(existsSync(fixture.restoreLog), false)
        const calls = await readFile(fixture.resticLog, 'utf8')
        assert.match(calls, /ARG=snapshots/)
        assert.doesNotMatch(calls, /ARG=restore/)
        assert.deepEqual(await readdir(fixture.cloudRoot), [])
      } finally {
        await removeFixture(fixture)
      }
    })
  }
})
