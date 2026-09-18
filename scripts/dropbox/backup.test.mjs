import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { SCOPES } from './oauth.mjs'
import { BLOCK, Digests, DropboxClient, validateCredential } from './backup-client.mjs'
import { POLICY, artifactPath, planUpload, planRetention, validateLedger } from './backup-policy.mjs'
import { backupJob } from './backup-job.mjs'
import { inspectSnapshot, encryptedArchive } from './backup-archive.mjs'
import { main } from './backup-cli.mjs'

const id = 'a'.repeat(32), sha = b => createHash('sha256').update(b).digest('hex')
const credential = () => ({ schema_version: 1, provider: 'dropbox', client_id: 'SyntheticApp123', refresh_token: 'SYNTHETIC_REFRESH', account_id: 'dbid:SYNTHETIC', scopes: [...SCOPES] })
const fakeCipher = () => Buffer.concat([Buffer.from('age-encryption.org/v1\n-> X25519 SYNTHETIC\n'), Buffer.alloc(200, 1)])
const digest = bytes => { const d = new Digests(); d.update(bytes); return d.finish() }
const empty = () => ({ version: 1, points: [], pending: [] })
const point = (n = 0, state = 'download_verified') => ({
  id: n.toString(16).padStart(32, '0'), bytes: 240, sha256: 'b'.repeat(64), contentHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64),
  remoteId: `id:fixture${n}`, rev: (n + 1).toString(16).padStart(9, '0'), createdAt: `2026-09-${String(n + 10).padStart(2, '0')}T00:00:00Z`, state,
  ...(state === 'restore_verified' ? { restoreReceiptHash: 'e'.repeat(64), restoredAt: '2026-09-15T00:00:00Z' } : {})
})
const file = p => ({ '.tag': 'file', id: p.remoteId, path_lower: artifactPath(p.id), size: p.bytes, content_hash: p.contentHash, rev: p.rev })
const response = value => new Response(JSON.stringify(value), { status: 200 })
async function* chunks(data, width = 17) { for (let i = 0; i < data.length; i += width) yield data.subarray(i, i + width) }

function fakeDropbox({ override } = {}) {
  const calls = [], uploaded = [], files = []
  let stored, metadata
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal)
    const route = new URL(url).pathname
    const arg = options.headers['Dropbox-API-Arg'] ? JSON.parse(options.headers['Dropbox-API-Arg']) :
      options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : JSON.parse(options.body || 'null')
    calls.push({ url, route, arg })
    const custom = await override?.({ route, arg, options, calls, metadata, stored })
    if (custom) return custom
    if (route === '/oauth2/token') {
      assert.equal(arg.client_secret, undefined)
      return response({ token_type: 'bearer', access_token: 'SYNTHETIC_ACCESS', expires_in: 3600, scope: SCOPES.join(' ') })
    }
    if (route.endsWith('/users/get_current_account')) return response({ account_id: 'dbid:SYNTHETIC' })
    if (route.endsWith('/files/list_folder')) return response({ entries: files, has_more: false, cursor: 'one' })
    if (route.endsWith('/upload_session/start')) return response({ session_id: 'SYNTHETIC_SESSION' })
    if (route.endsWith('/upload_session/append_v2')) {
      assert.equal(arg.cursor.offset, uploaded.reduce((n, b) => n + b.length, 0))
      uploaded.push(Buffer.from(options.body)); return response(null)
    }
    if (route.endsWith('/upload_session/finish')) {
      assert.equal(arg.commit.mode, 'add'); assert.equal(arg.commit.autorename, false); assert.equal(arg.commit.strict_conflict, true)
      stored = Buffer.concat(uploaded)
      metadata = { '.tag': 'file', id: 'id:SYNTHETIC_FILE', rev: '123456789abcd', size: stored.length, content_hash: digest(stored).contentHash, path_lower: arg.commit.path }
      files.push(metadata); return response(metadata)
    }
    if (route.endsWith('/files/download')) {
      assert.equal(arg.path, `rev:${metadata.rev}`)
      return new Response(stored, { headers: { 'dropbox-api-result': JSON.stringify(metadata) } })
    }
    throw new Error('Unexpected fixture endpoint')
  }
  return { client: new DropboxClient(credential(), { fetchImpl }), calls, files, uploaded }
}

test('content hashes match independent empty, short and multi-block computation', () => {
  for (const length of [0, 1, 1000, BLOCK, BLOCK + 10]) {
    const bytes = Buffer.alloc(length, 7), d = new Digests(), blocks = []
    for (let i = 0; i < bytes.length; i += 1337) d.update(bytes.subarray(i, i + 1337))
    for (let i = 0; i < bytes.length; i += BLOCK) blocks.push(createHash('sha256').update(bytes.subarray(i, i + BLOCK)).digest())
    assert.deepEqual(d.finish(), { bytes: length, sha256: sha(bytes), contentHash: sha(Buffer.concat(blocks)) })
  }
})

test('credential schema and scope set reject widening and control characters', () => {
  validateCredential(credential())
  for (const change of [{ refresh_token: 'bad\nheader' }, { account_id: '' }, { scopes: [...SCOPES, 'sharing.write'] }, { scopes: SCOPES.slice(1) }]) {
    assert.throws(() => validateCredential({ ...credential(), ...change }), /invalid_credential/)
  }
})

test('inventory verifies the fixed account before file APIs, no secret parameter', async () => {
  const mock = fakeDropbox(); assert.deepEqual(await mock.client.inventory(), [])
  assert.deepEqual(mock.calls.map(c => c.route), ['/oauth2/token', '/2/users/get_current_account', '/2/files/list_folder'])
  assert.ok(mock.calls.every(c => new URL(c.url).origin === 'https://api.dropboxapi.com'))
})

test('account mismatch and failed identity lookup cannot cache an unchecked token', async () => {
  for (const responseForAccount of [() => response({ account_id: 'dbid:OTHER' }), () => new Response('SECRET', { status: 500 })]) {
    const mock = fakeDropbox({ override: ({ route }) => route.endsWith('/get_current_account') ? responseForAccount() : null })
    await assert.rejects(mock.client.inventory()); await assert.rejects(mock.client.inventory())
    assert.equal(mock.calls.filter(c => c.route === '/oauth2/token').length, 2)
    assert.equal(mock.calls.some(c => c.route.includes('/files/')), false)
  }
})

test('inventory follows pagination and refuses cursor replay, duplicate IDs and missing sizes', async () => {
  let page = 0
  const p = point()
  const good = fakeDropbox({ override: ({ route }) => route.includes('list_folder') ? response(++page === 1 ? { entries: [file(p)], cursor: 'next', has_more: true } : { entries: [], cursor: 'end', has_more: false }) : null })
  assert.equal((await good.client.inventory()).length, 1)
  for (const page of [{ entries: [], cursor: 'repeat', has_more: true }, { entries: [file(p), file(p)], has_more: false }, { entries: [{ ...file(p), size: -1 }], has_more: false }]) {
    const bad = fakeDropbox({ override: ({ route }) => route.includes('list_folder') ? response(page) : null })
    await assert.rejects(bad.client.inventory(), /invalid_inventory/)
  }
})

test('upload uses exact offsets, verified age header, no clobber, metadata hashes and exact revision download', async () => {
  const mock = fakeDropbox(), bytes = fakeCipher(); let checked = false
  const receipt = await mock.client.upload(id, chunks(bytes), 1000, async () => { checked = true })
  assert.equal(checked, true); assert.equal(receipt.sha256, sha(bytes)); assert.equal(receipt.bytes, bytes.length)
  const received = []
  await mock.client.download({ id, ...receipt }, async b => received.push(b))
  assert.deepEqual(Buffer.concat(received), bytes)
  assert.equal(mock.calls.filter(c => c.route.endsWith('finish')).length, 1)
})

test('plaintext header never uploads even its prefix; truncation, over-budget and upstream failure cannot commit', async () => {
  const cases = [
    [chunks(Buffer.from('PLAINTEXT_DATABASE_SECRET_SHOULD_NOT_LEAVE'), 1), 1000],
    [chunks(fakeCipher().subarray(0, 10), 1), 1000],
    [chunks(fakeCipher()), 100],
    [(async function* () { yield fakeCipher(); throw new Error('PRIVATE_PRODUCER_ERROR') })(), 1000]
  ]
  for (let i = 0; i < cases.length; i++) {
    const mock = fakeDropbox()
    await assert.rejects(mock.client.upload(id, ...cases[i], async () => {}))
    assert.equal(mock.calls.some(c => c.route.endsWith('/finish')), false)
    if (i < 2) assert.equal(mock.uploaded.length, 0)
  }
})

test('API failure is sanitized and no write request is automatically retried', async () => {
  const mock = fakeDropbox({ override: ({ route }) => route.endsWith('/append_v2') ? new Response('SECRET_PROVIDER_DETAIL', { status: 429 }) : null })
  await assert.rejects(mock.client.upload(id, chunks(fakeCipher()), 1000, async () => {}), error => error.message === 'dropbox_http_429')
  assert.equal(mock.calls.filter(c => c.route.endsWith('/append_v2')).length, 1)
  assert.equal(mock.calls.some(c => c.route.endsWith('/finish')), false)
})

test('download rejects truncated content, extra bytes and wrong revision', async () => {
  for (const variant of ['short', 'long', 'rev']) {
    const mock = fakeDropbox({ override: ({ route, metadata, stored }) => {
      if (!route.endsWith('/download')) return null
      return new Response(variant === 'short' ? stored.subarray(0, stored.length - 1) : variant === 'long' ? Buffer.concat([stored, Buffer.from('x')]) : stored,
        { headers: { 'dropbox-api-result': JSON.stringify({ ...metadata, ...(variant === 'rev' ? { rev: 'fffffffff' } : {}) }) } })
    } })
    const receipt = await mock.client.upload(id, chunks(fakeCipher()), 1000, async () => {})
    await assert.rejects(mock.client.download({ id, ...receipt }, async () => {}), /download_/)
  }
})

test('policy counts all App Folder objects, max 3 points and fixed 5GB/1GB reservations', () => {
  assert.equal(POLICY.budgetBytes, 5_000_000_000)
  assert.equal(planUpload(empty(), [], 1).remainingBytes, POLICY.budgetBytes - 1)
  const other = { '.tag': 'file', id: 'id:unknown', path_lower: '/other', size: 4_999_999_999 }
  assert.throws(() => planUpload(empty(), [other], 2), /budget_exceeded/)
  assert.throws(() => planUpload(empty(), [], POLICY.maxUploadBytes + 1), /invalid_upload_reservation/)
  const points = [point(0), point(1), point(2)]
  assert.throws(() => planUpload({ ...empty(), points }, points.map(file), 1000), /retention_review_required/)
})

test('pending state, unknown cloud artifacts, changed revisions and malformed ledger fail closed', () => {
  const p = point()
  assert.throws(() => planUpload({ ...empty(), pending: [{ id, reservedBytes: 100, createdAt: new Date().toISOString() }] }, [], 1), /reconciliation/)
  assert.throws(() => planUpload(empty(), [file(p)], 1), /unknown_backup/)
  assert.throws(() => planUpload({ ...empty(), points: [p] }, [{ ...file(p), rev: 'fffffffff' }], 1), /repository_changed/)
  assert.throws(() => validateLedger({ ...empty(), points: [{ ...p, bytes: NaN }] }), /invalid_ledger/)
  assert.throws(() => validateLedger({ ...empty(), points: [point(0, 'restore_verified'), point(0)] }), /invalid_ledger/)
})

test('retention only suggests; unverified points never authorize loss of the last restored point', () => {
  const points = [point(0, 'restore_verified'), point(1), point(2)]
  const plan = planRetention({ ...empty(), points })
  assert.ok(plan.protectedIds.includes(points[0].id)); assert.deepEqual(plan.candidates, [])
  assert.equal(planRetention({ ...empty(), points: points.map(p => ({ ...p, state: 'uploaded' })) }).reason, 'no_verified_restore')
  const more = [...points, point(3, 'restore_verified')]
  more[3].restoredAt = '2026-09-18T00:00:00Z'
  assert.ok(planRetention({ ...empty(), points: more }).candidates.some(p => p.id === points[0].id))
})

test('job persists reservation before network write and records download verification separately from restore', async () => {
  const mock = fakeDropbox(), saved = []
  const result = await backupJob({ client: mock.client, ledger: empty(), saveLedger: async l => saved.push(structuredClone(l)), archive: chunks(fakeCipher()), manifestHash: 'a'.repeat(64), reservedBytes: 1000, id })
  assert.equal(saved[0].pending.length, 1); assert.equal(saved[1].points[0].state, 'uploaded')
  assert.equal(saved[2].points[0].state, 'download_verified'); assert.equal(result.restoreVerified, false)
  assert.equal(saved[2].pending.length, 0)
})

test('ambiguous finish and producer failure retain pending reservation; restart is blocked', async () => {
  const mock = fakeDropbox({ override: ({ route }) => route.endsWith('/finish') ? new Response('SECRET', { status: 503 }) : null })
  const saved = []
  await assert.rejects(backupJob({ client: mock.client, ledger: empty(), saveLedger: async l => saved.push(structuredClone(l)), archive: chunks(fakeCipher()), manifestHash: 'a'.repeat(64), reservedBytes: 1000, id }))
  assert.equal(saved.length, 1)
  assert.throws(() => planUpload(saved[0], [], 1), /pending_upload/)
})

test('durability failure prevents starting upload; failed readback remains uploaded, never restored', async () => {
  const first = fakeDropbox()
  await assert.rejects(backupJob({ client: first.client, ledger: empty(), saveLedger: async () => { throw new Error('SYNTHETIC_DISK_FULL') }, archive: chunks(fakeCipher()), manifestHash: 'a'.repeat(64), reservedBytes: 1000, id }))
  assert.equal(first.calls.some(c => c.route.includes('upload_session')), false)
  const second = fakeDropbox({ override: ({ route }) => route.endsWith('/download') ? new Response('SECRET', { status: 503 }) : null }), saved = []
  await assert.rejects(backupJob({ client: second.client, ledger: empty(), saveLedger: async l => saved.push(structuredClone(l)), archive: chunks(fakeCipher()), manifestHash: 'a'.repeat(64), reservedBytes: 1000, id }))
  assert.equal(saved.at(-1).points[0].state, 'uploaded')
})

test('canonical source verifier rejects corruption and unlisted members; never alters source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nav-dropbox-fixture-'))
  const snapshot = join(root, 'nav-20260918T000000Z-abcdef0')
  try {
    await mkdir(join(snapshot, 'database'), { recursive: true, mode: 0o700 }); await mkdir(join(snapshot, 'metadata'), { mode: 0o700 })
    const dump = Buffer.from('PGDMP-SYNTHETIC-NOT-A-RESTORABLE-DATABASE'), tree = Buffer.from('SYNTHETIC-TREE')
    await writeFile(join(snapshot, 'database/nav.dump'), dump, { mode: 0o600 }); await writeFile(join(snapshot, 'metadata/tree.tsv'), tree, { mode: 0o600 })
    await writeFile(join(snapshot, 'manifest.sha256'), `${sha(dump)}  ./database/nav.dump\n${sha(tree)}  ./metadata/tree.tsv\n`, { mode: 0o600 })
    const inspected = await inspectSnapshot(root, snapshot)
    assert.ok(inspected.reservedBytes > dump.length); assert.equal(inspected.manifestHash.length, 64)
    await writeFile(join(snapshot, 'unexpected.txt'), 'synthetic', { mode: 0o600 })
    await assert.rejects(inspectSnapshot(root, snapshot), /unlisted_snapshot_file/)
    await rm(join(snapshot, 'unexpected.txt'))
    await writeFile(join(snapshot, 'database/nav.dump'), 'corrupt')
    await assert.rejects(inspectSnapshot(root, snapshot), /snapshot_hash_mismatch/)
    assert.equal(await readFile(join(snapshot, 'database/nav.dump'), 'utf8'), 'corrupt')
  } finally {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.ok(basename(root).startsWith('nav-dropbox-fixture-'))
    assert.equal((await lstat(root)).isSymbolicLink(), false)
    await rm(resolve(root), { recursive: true, force: true }) // only this verified mkdtemp fixture
  }
})

test('missing archive executables and invalid recipient cannot produce a completed stream', async () => {
  await assert.rejects(async () => { for await (const _ of encryptedArchive('/synthetic', 'invalid')) {} }, /invalid_age_recipient/)
  await assert.rejects(async () => { for await (const _ of encryptedArchive('/synthetic', 'age1' + 'q'.repeat(58), { tar: 'nav-fixture-no-tar', age: 'nav-fixture-no-age' })) {} }, /archive_encryption_failed/)
})

test('candidate defaults disable upload; no timer or delete API and Windows cannot run production CLI', async () => {
  const config = JSON.parse(await readFile(new URL('./backup-config.example.json', import.meta.url), 'utf8'))
  assert.equal(config.allowUpload, false)
  const client = await readFile(new URL('./backup-client.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /files\/delete|files\/move|files\/copy|files\/permanently_delete/)
  if (process.platform !== 'linux') await assert.rejects(main(['backup', 'ignored']), /linux_operator_root_required/)
})
