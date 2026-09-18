// Disposable Linux acceptance ONLY. No Dropbox credentials or external file requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm, open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { inspectSnapshot, encryptedArchive } from './backup-archive.mjs'
import { backupJob } from './backup-job.mjs'
import { Digests } from './backup-client.mjs'
import { artifactPath } from './backup-policy.mjs'
import { main } from './backup-cli.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1_000_000, ...options })
  assert.equal(result.status, 0, 'Synthetic integration command failed (output suppressed)')
  return result.stdout?.trim()
}
async function streamProcess(binary, args, input, output) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] })
  const done = new Promise((res, rej) => { child.once('error', rej); child.once('close', c => c === 0 ? res() : rej(new Error('Synthetic child failed'))) })
  const copying = input ? pipeline(createReadStream(input), child.stdin) : Promise.resolve(child.stdin.end())
  const saving = output ? pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 })) : Promise.resolve(child.stdout.resume())
  await Promise.all([done, copying, saving])
}

test('Linux: real age roundtrip, tamper rejection, real PG dump/restore, root CLI and canonical lock', { timeout: 120_000 }, async () => {
  assert.equal(process.platform, 'linux', 'Run only in explicitly approved disposable Linux runner')
  assert.equal(process.getuid(), 0)
  assert.equal(process.env.NAV_DROPBOX_DISPOSABLE_TEST, '1', 'Disposable test authorization flag is required')
  process.umask(0o077)
  const root = await mkdtemp('/var/lib/nav-dropbox-fixture-')
  const dockerIds = []
  const run = randomBytes(8).toString('hex')
  try {
    const ageKey = join(root, 'synthetic-identity.txt')
    command('/usr/bin/age-keygen', ['-o', ageKey]) // never display key or tool stderr
    const recipient = command('/usr/bin/age-keygen', ['-y', ageKey])
    const backups = join(root, 'snapshots'), snapshot = join(backups, 'nav-20260918T000000Z-abcdef0')
    await mkdir(join(snapshot, 'database'), { recursive: true, mode: 0o700 }); await mkdir(join(snapshot, 'metadata'), { mode: 0o700 })
    async function database(role) {
      const id = command('docker', ['run', '--detach', '--rm', '--network', 'none', '--name', `nav-dropbox-fixture-${run}-${role}`,
        '--memory', '256m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/var/lib/postgresql/data:rw,size=128m',
        '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=nav', 'postgres:16-alpine'])
      assert.match(id, /^[a-f0-9]{64}$/); dockerIds.push(id)
      for (let n = 0; n < 80; n++) {
        if (spawnSync('docker', ['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'nav'], { stdio: 'ignore' }).status === 0) return id
        await sleep(250)
      }
      throw new Error('Synthetic database startup timeout')
    }
    const source = await database('source')
    const sql = "CREATE TABLE notes(id bigint PRIMARY KEY, body text NOT NULL); INSERT INTO notes VALUES(1,'SYNTHETIC-NOTE-A'),(2,'SYNTHETIC-NOTE-B');"
    command('docker', ['exec', source, 'psql', '-U', 'postgres', '-d', 'nav', '-v', 'ON_ERROR_STOP=1', '-c', sql])
    const dump = join(snapshot, 'database/nav.dump')
    await streamProcess('docker', ['exec', source, 'pg_dump', '-U', 'postgres', '-d', 'nav', '-Fc', '--no-owner', '--no-acl'], null, dump)
    const tree = 'f\t600\tdatabase/nav.dump\t\nf\t600\tmetadata/tree.tsv\t\n'
    await writeFile(join(snapshot, 'metadata/tree.tsv'), tree, { mode: 0o600 })
    await writeFile(join(snapshot, 'manifest.sha256'), `${sha(await readFile(dump))}  ./database/nav.dump\n${sha(tree)}  ./metadata/tree.tsv\n`, { mode: 0o600 })
    const info = await inspectSnapshot(backups, snapshot)
    let ciphertext, remote, saved
    const mockCloud = {
      async inventory() { return remote ? [remote] : [] },
      async upload(id, chunks, reserved, beforeCommit) {
        const buffers = [], d = new Digests()
        for await (const b of chunks) { buffers.push(Buffer.from(b)); d.update(b) }
        ciphertext = Buffer.concat(buffers); const result = d.finish(); assert.ok(result.bytes <= reserved)
        await beforeCommit(result)
        remote = { '.tag': 'file', path_lower: artifactPath(id), id: 'id:SYNTHETIC', rev: '123456789abcd', size: result.bytes, content_hash: result.contentHash }
        return { ...result, remoteId: remote.id, rev: remote.rev }
      },
      async download(p, write) { assert.equal(sha(ciphertext), p.sha256); await write(ciphertext) }
    }
    const result = await backupJob({ client: mockCloud, ledger: { version: 1, points: [], pending: [] }, saveLedger: async l => { saved = structuredClone(l) },
      archive: encryptedArchive(snapshot, recipient), manifestHash: info.manifestHash, reservedBytes: info.reservedBytes })
    assert.equal(result.state, 'download_verified'); assert.equal(result.restoreVerified, false)
    assert.equal(saved.points[0].state, 'download_verified')
    assert.equal(ciphertext.includes(Buffer.from('SYNTHETIC-NOTE-A')), false)
    const encrypted = join(root, 'roundtrip.tar.age'), archive = join(root, 'roundtrip.tar')
    await writeFile(encrypted, ciphertext, { mode: 0o600 })
    command('/usr/bin/age', ['--decrypt', '--identity', ageKey, '--output', archive, encrypted])
    const listing = command('/usr/bin/tar', ['-tf', archive]).split('\n')
    const allowed = new Set(['./', './database/', './database/nav.dump', './metadata/', './metadata/tree.tsv', './manifest.sha256'])
    assert.ok(listing.every(p => allowed.has(p)))
    const restored = join(root, 'restored'); await mkdir(restored, { mode: 0o700 })
    command('/usr/bin/tar', ['--extract', '--file', archive, '--directory', restored, '--no-same-owner', '--no-same-permissions'])
    assert.equal(sha(await readFile(join(restored, 'database/nav.dump'))), sha(await readFile(dump)))
    const target = await database('restore')
    await streamProcess('docker', ['exec', '-i', target, 'pg_restore', '-U', 'postgres', '-d', 'nav', '--no-owner', '--no-acl', '--exit-on-error'], join(restored, 'database/nav.dump'), null)
    const query = ['psql', '-U', 'postgres', '-d', 'nav', '-At', '-c', 'SELECT row_to_json(n) FROM notes n ORDER BY id']
    assert.equal(command('docker', ['exec', target, ...query]), command('docker', ['exec', source, ...query]))
    const tampered = Buffer.from(ciphertext); tampered[tampered.length - 1] ^= 1
    const bad = join(root, 'tampered.age'); await writeFile(bad, tampered, { mode: 0o600 })
    const rejected = spawnSync('/usr/bin/age', ['--decrypt', '--identity', ageKey, '--output', join(root, 'untrusted-partial.tar'), bad], { stdio: 'ignore' })
    assert.notEqual(rejected.status, 0)
    // Root CLI never opens a network connection for init/list or a disabled upload.
    const state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
    const configFile = join(root, 'config.json'), credentialsFile = join(root, 'connection.json')
    const scopes = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write']
    await writeFile(credentialsFile, JSON.stringify({ schema_version: 1, provider: 'dropbox', client_id: 'SyntheticApp123', refresh_token: 'SYNTHETIC', account_id: 'dbid:SYNTHETIC', scopes }), { mode: 0o600 })
    await writeFile(configFile, JSON.stringify({ version: 1, allowUpload: false, credentialsFile, stateDirectory: state, backupRoot: backups, ageRecipient: recipient }), { mode: 0o600 })
    assert.equal((await main(['init-local', configFile])).cloudAccess, false)
    assert.equal((await main(['list', configFile])).points.length, 0)
    await assert.rejects(main(['init-local', configFile])) // no overwrite
    await assert.rejects(main(['backup', configFile, snapshot]), /upload_not_enabled/)
    const lock = await open('/run/lock/nav-backup.lock', 'r+')
    try {
      assert.equal(spawnSync('/usr/bin/flock', ['-xn', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] }).status, 0)
      await assert.rejects(main(['list', configFile]), /backup_or_restore_already_running/)
    } finally { await lock.close() }
    console.log('SYNTHETIC_LINUX_AGE_PG_RESTORE_PASS; REAL_DROPBOX=false; PRODUCTION=false')
  } finally {
    for (const id of dockerIds) spawnSync('docker', ['rm', '--force', id], { stdio: 'ignore', timeout: 30_000 })
    assert.ok(resolve(root).startsWith('/var/lib/nav-dropbox-fixture-') && dirnameSafe(root))
    await rm(root, { recursive: true, force: true }) // only this mkdtemp, includes disposable test key
  }
})
function dirnameSafe(path) { return path.split('/').length === 4 && path !== '/var/lib' }
