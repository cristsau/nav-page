// Explicitly disposable, Linux/root, synthetic-only service acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { initUploadStore } from './init-upload-store.mjs'
import { initialControlState } from './control-core.mjs'

test('Linux private host: explicit initialization, durable restart, permissions and singleton lease after GC', { timeout: 30000 }, async () => {
  assert.equal(process.env.NAV_DROPBOX_DISPOSABLE_TEST, '1'); assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0)
  process.umask(0o077)
  const root = await mkdtemp('/var/lib/nav-control-fixture-'), configPath = join(root, 'control-config.json')
  const host = resolve('scripts/dropbox/control-host.mjs'), owner = '00000000-0000-4000-8000-000000000001'
  const stateDirectory = join(root, 'control'), socketDirectory = join(root, 'socket'), statusDirectory = join(root, 'integrations')
  const backupState = join(root, 'backup'), backupConfig = join(root, 'backup-config.json'), snapshotConfig = join(root, 'snapshot.env'), snapshotScript = join(root, 'snapshot.sh')
  const socketPath = join(socketDirectory, 'control.sock')
  let child
  const stop = async () => { if (child && child.exitCode === null) { const ended = once(child, 'close'); child.kill('SIGTERM'); await ended }; child = null }
  const request = (method, path, body, who = owner) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method, headers: { 'x-nav-owner': who, 'content-type': 'application/json' }, timeout: 1500 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('TEST_TIMEOUT'))); req.end(body ? JSON.stringify(body) : undefined)
  })
  async function start() {
    // Forcing GC after start verifies that the FileHandle lease remains rooted.
    child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', `import {startHost} from ${JSON.stringify(pathToFileURL(host).href)}; await startHost(${JSON.stringify(configPath)}); for(let i=0;i<5;i++) global.gc();`], { stdio: 'ignore' })
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw Error('SYNTHETIC_HOST_START_FAILED')
      try { const r = await request('GET', '/v1/status'); if (r.status === 200) return r.body } catch { /* socket not ready */ }
      await new Promise(r => setTimeout(r, 25))
    }
    throw Error('SYNTHETIC_HOST_START_TIMEOUT')
  }
  try {
    for (const dir of [stateDirectory, socketDirectory, statusDirectory, backupState]) await mkdir(dir, { mode: 0o700 })
    await writeFile(backupConfig, JSON.stringify({ stateDirectory: backupState, allowUpload: false }), { mode: 0o600 })
    await writeFile(join(backupState, 'ledger.json'), JSON.stringify({ version: 1, points: [], pending: [], pendingDeletes: [] }), { mode: 0o600 })
    await writeFile(snapshotConfig, 'SYNTHETIC_ONLY=1\n', { mode: 0o600 })
    await writeFile(snapshotScript, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    await writeFile(configPath, JSON.stringify({ version: 1, ownerUserId: owner, stateDirectory, socketDirectory, statusDirectory, backupConfig, snapshotConfig, snapshotScript,
      allowManual: false, allowSchedule: false, allowDownload: false }), { mode: 0o600 })
    const init = () => spawnSync(process.execPath, [host, 'init', configPath], { stdio: 'ignore', timeout: 5000 }).status
    assert.equal(init(), 0); assert.notEqual(init(), 0)
    assert.equal((await stat(join(stateDirectory, 'control.json'))).mode & 0o777, 0o600)
    const first = await start(); assert.equal(first.connected, true); assert.equal(first.schedule.active, false)
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600)
    assert.equal((await request('GET', '/v1/status', null, 'not-owner')).status, 403)
    assert.equal((await request('POST', '/v1/jobs', { id: 'a'.repeat(32), kind: 'backup' })).status, 503)
    assert.equal((await request('PUT', '/v1/schedule', { enabled: false, revision: 0, time: '04:15' })).status, 200)
    const contender = spawnSync(process.execPath, [host, 'serve', configPath], { stdio: 'ignore', timeout: 5000 })
    assert.equal(contender.status, 1, 'Second host must fail promptly while first holds lease')
    assert.equal((await request('GET', '/v1/status')).body.revision, 1)
    await stop(); assert.equal((await start()).schedule.time, '04:15'); await stop()
    const interrupted = initialControlState(), now = new Date().toISOString()
    interrupted.jobs.push({ id: 'b'.repeat(32), kind: 'backup', pointId: null, source: 'manual', state: 'running', stage: 'upload', code: null, createdAt: now, updatedAt: now })
    await writeFile(join(stateDirectory, 'control.json'), JSON.stringify(interrupted), { mode: 0o600 })
    const recovered = await start(); assert.equal(recovered.reviewRequired, true); assert.equal(recovered.jobs[0].state, 'review'); await stop()
    assert.equal(JSON.parse(await readFile(join(stateDirectory, 'control.json'), 'utf8')).jobs[0].state, 'review')
    for (const purpose of ['web', 'offline']) {
      assert.equal((await initUploadStore(statusDirectory, purpose)).purpose, purpose)
      await assert.rejects(initUploadStore(statusDirectory, purpose), /ALREADY_INITIALIZED_OR_PARTIAL/)
    }
    const web = JSON.parse(await readFile(join(statusDirectory, 'dropbox-uploads.json'), 'utf8'))
    const offline = JSON.parse(await readFile(join(statusDirectory, 'dropbox-offline-uploads.json'), 'utf8'))
    assert.notEqual(web.key, offline.key)
    assert.equal((await stat(join(statusDirectory, 'dropbox-offline-uploads.json'))).mode & 0o777, 0o600)
  } finally { await stop(); await rm(root, { recursive: true, force: true }) }
})
