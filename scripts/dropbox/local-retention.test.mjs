import test from 'node:test'
import { sealFixture } from './snapshot-fixture.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rmdir, symlink, utimes, chown, chmod, unlink } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { planLocalRetention, pruneLocalRetention } from './local-retention.mjs'
import { main } from './backup-cli.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const snapshotName = n => `nav-2000010${n}T000000Z-nogit`
async function fixture(run) {
  const base = process.platform === 'linux' ? '/var/lib' : tmpdir()
  const dir = await mkdtemp(join(base, 'nav-retention-fixture-')), root = join(dir, 'backups')
  try {
    await mkdir(root, { mode: 0o700 })
    async function snapshot(n) {
      const path = join(root, snapshotName(n))
      await mkdir(path, { mode: 0o700 }); await mkdir(join(path, 'database'), { mode: 0o700 }); await mkdir(join(path, 'metadata'), { mode: 0o700 })
      await writeFile(join(path, 'database/nav.dump'), 'SYNTHETIC-DUMP', { mode: 0o600 })
      await writeFile(join(path, 'metadata/tree.tsv'), 'SYNTHETIC-TREE', { mode: 0o600 })
      await writeFile(join(path, 'manifest.sha256'), `${sha('SYNTHETIC-DUMP')}  ./database/nav.dump\n${sha('SYNTHETIC-TREE')}  ./metadata/tree.tsv\n`, { mode: 0o600 })
      await sealFixture(path)
      return path
    }
    await run({ root, dir, snapshot })
  } finally {
    assert.equal(dirname(resolve(dir)).toLowerCase(), resolve(base).toLowerCase())
    assert.ok(dir.split(/[\\/]/).at(-1).startsWith('nav-retention-fixture-'))
    await rm(resolve(dir), { recursive: true, force: true })
  }
}

test('local plan keeps newest three by snapshot timestamp, not mutable directory mtime; nogit supported', () => fixture(async ({ root, snapshot }) => {
  for (let n = 1; n <= 5; n++) await snapshot(n)
  await utimes(join(root, snapshotName(1)), new Date(), new Date())
  await writeFile(join(root, 'unrelated.txt'), 'DO-NOT-DELETE', { mode: 0o600 })
  const result = await planLocalRetention(root)
  assert.deepEqual(result.keep.map(s => s.name), [5, 4, 3].map(snapshotName))
  assert.deepEqual(result.remove.map(s => s.name), [2, 1].map(snapshotName))
  assert.equal((await readdir(root)).length, 6)
}))

test('corrupt newest snapshot blocks whole plan without deleting older snapshots', () => fixture(async ({ root, snapshot }) => {
  for (let n = 1; n <= 4; n++) await snapshot(n)
  await writeFile(join(root, snapshotName(4), 'database/nav.dump'), 'CORRUPTION')
  await assert.rejects(planLocalRetention(root), /snapshot_hash_mismatch/)
  assert.equal((await readdir(root)).length, 4)
}))

test('unfinished snapshot, ambiguous names and broad roots block local retention', () => fixture(async ({ root, snapshot }) => {
  await assert.rejects(planLocalRetention('/'), /unsafe_retention_root/)
  await snapshot(1)
  await mkdir(join(root, '.nav-backup.in-progress'))
  await assert.rejects(planLocalRetention(root), /unfinished_local_snapshot/)
  await rmdir(join(root, '.nav-backup.in-progress'))
  await mkdir(join(root, 'nav-20000101T000000Z-abcdef0'))
  await assert.rejects(planLocalRetention(root), /ambiguous_snapshot_order/)
}))

test('fewer than four snapshots never yields deletion candidates; production defaults opt out', () => fixture(async ({ root, snapshot }) => {
  assert.deepEqual((await planLocalRetention(root)).remove, [])
  await snapshot(1)
  assert.deepEqual((await planLocalRetention(root)).remove, [])
  const config = JSON.parse(await readFile(new URL('./backup-config.example.json', import.meta.url)))
  assert.equal(config.allowLocalPrune, false)
  await assert.rejects(pruneLocalRetention(root), /local_prune_not_enabled|linux_operator_root_required/)
}))

test('Linux: enabled CLI cleanup deletes only verified old local snapshots and requires no cloud credentials', { skip: process.platform !== 'linux' }, () => fixture(async ({ root, dir, snapshot }) => {
  assert.equal(process.getuid(), 0)
  for (let n = 1; n <= 5; n++) await snapshot(n)
  await writeFile(join(root, 'unrelated.txt'), 'DO-NOT-DELETE', { mode: 0o600 })
  const state = join(dir, 'state'); await mkdir(state, { mode: 0o700 })
  const config = join(dir, 'config.json')
  await writeFile(config, JSON.stringify({ version: 1, allowUpload: false, allowLocalPrune: true, credentialsFile: join(dir, 'ABSENT'), stateDirectory: state, backupRoot: root }), { mode: 0o600 })
  const result = await main(['prune-local', config])
  assert.deepEqual(result.removed, [2, 1].map(snapshotName)); assert.equal(result.cloudWrite, false)
  assert.deepEqual((await readdir(root)).filter(n => n.startsWith('nav-')).sort().reverse(), [5, 4, 3].map(snapshotName))
  assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'DO-NOT-DELETE')
  assert.deepEqual((await main(['prune-local', config])).removed, [])
}))

test('Linux: symlink member or snapshot cannot redirect cleanup outside backup root', { skip: process.platform !== 'linux' }, () => fixture(async ({ root, dir, snapshot }) => {
  assert.equal(process.getuid(), 0)
  const outside = join(dir, 'KEEP.txt'); await writeFile(outside, 'KEEP', { mode: 0o600 })
  for (let n = 1; n <= 4; n++) await snapshot(n)
  await symlink(outside, join(root, snapshotName(1), 'evil'))
  await assert.rejects(pruneLocalRetention(root, { enabled: true }), /unsafe_snapshot_member/)
  assert.equal((await readdir(root)).length, 4); assert.equal(await readFile(outside, 'utf8'), 'KEEP')
}))

test('Linux: canonical declared internal links and preserved non-root file owner are supported without following links', { skip: process.platform !== 'linux' }, () => fixture(async ({ root, snapshot }) => {
  for (let n = 1; n <= 4; n++) {
    const path = await snapshot(n)
    await writeFile(join(path, 'metadata/owned.txt'), 'SYNTHETIC-OWNED', { mode: 0o644 })
    await chown(join(path, 'metadata/owned.txt'), 1001, 1001)
    await symlink('owned.txt', join(path, 'metadata/internal-link'))
    await sealFixture(path)
  }
  assert.deepEqual((await pruneLocalRetention(root, { enabled: true })).removed, [snapshotName(1)])
  assert.equal(await readFile(join(root, snapshotName(4), 'metadata/internal-link'), 'utf8'), 'SYNTHETIC-OWNED')
}))

test('Linux: declared link cannot escape snapshot; changed link or declared mode mismatch blocks pruning', { skip: process.platform !== 'linux' }, () => fixture(async ({ root, dir, snapshot }) => {
  const path = await snapshot(1), linkPath = join(path, 'metadata/link')
  await writeFile(join(dir, 'outside.txt'), 'KEEP', { mode: 0o600 })
  await symlink(join(dir, 'outside.txt'), linkPath); await sealFixture(path)
  await assert.rejects(planLocalRetention(root), /unsafe_snapshot_symlink/)
  await unlink(linkPath); await symlink('../database/nav.dump', linkPath); await sealFixture(path)
  await unlink(linkPath); await symlink('tree.tsv', linkPath)
  await assert.rejects(planLocalRetention(root), /unsafe_snapshot_symlink/)
  await unlink(linkPath); await sealFixture(path)
  await chmod(join(path, 'database/nav.dump'), 0o644)
  await assert.rejects(planLocalRetention(root), /snapshot_tree_mismatch/)
}))
