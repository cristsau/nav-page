import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createAppUpdates, parseBuildInfo } from '../../app/src/shared/services/appUpdates.js'
import { registerReloadGuard, assertSafeToReload, confirmVersionReload } from '../../app/src/shared/services/reloadGuards.js'
import { createVersionPlugin } from '../../app/build/versionPlugin.mjs'

const build = (id = 'build-a') => ({ schemaVersion: 1, version: '2026.09.09', buildId: id, builtAt: '2026-09-09T03:00:00Z', notes: ['更新说明'] })
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

test('build metadata is emitted exactly as embedded and contains only public fields', () => {
  const plugin = createVersionPlugin({ command: 'build', now: new Date('2026-09-09T03:00:00Z'), nonce: '12345678-rest' })
  const embedded = JSON.parse(plugin.config().define.__NAV_BUILD_INFO__)
  let artifact
  plugin.generateBundle.call({ emitFile(value) { artifact = value } })
  assert.equal(artifact.fileName, 'version.json')
  assert.deepEqual(JSON.parse(artifact.source), embedded)
  assert.equal(embedded.buildId, '20260909030000000-12345678')
  assert.deepEqual(Object.keys(embedded).sort(), ['buildId', 'builtAt', 'notes', 'schemaVersion', 'version'])
  assert.deepEqual(parseBuildInfo(embedded), embedded)
})

test('version shape rejects malformed metadata and does not preserve extra fields', () => {
  for (const value of [null, {}, { ...build(), schemaVersion: 2 }, { ...build(), buildId: 'https://evil.test/x' }, { ...build(), notes: ['x'.repeat(241)] }, { ...build(), builtAt: 'bad' }]) {
    assert.throws(() => parseBuildInfo(value))
  }
  assert.deepEqual(parseBuildInfo({ ...build(), unknown: 'discard' }), build())
})

test('checks are coalesced, bounded, no-store and independent from authentication', async () => {
  let calls = 0, release
  const updates = createAppUpdates({ currentBuild: build(), fetchImpl: async (url, options) => {
    calls++
    assert.match(url, /^\/version\.json\?check=\d+$/)
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    await new Promise((resolve) => { release = resolve })
    return json(build())
  } })
  const one = updates.check(), two = updates.check()
  assert.equal(updates.snapshot().busy, true)
  release(); await Promise.all([one, two])
  assert.equal(calls, 1)
  assert.equal(updates.snapshot().status, 'current')
  assert.equal(updates.snapshot().busy, false)
})

test('different builds including a server rollback are available without semantic version ordering', async () => {
  const updates = createAppUpdates({ currentBuild: build('newer'), fetchImpl: async () => json({ ...build('older'), version: '2026.09.01' }) })
  await updates.check()
  assert.equal(updates.snapshot().status, 'available')
})

test('HTTP, login HTML, malformed data, offline and deadline failures never say latest', async () => {
  for (const fetchImpl of [
    async () => new Response('', { status: 401 }),
    async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    async () => json({}),
    async () => { throw new Error('offline') },
    async () => new Promise(() => {}),
    async () => ({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: () => new Promise(() => {}) })
  ]) {
    const updates = createAppUpdates({ currentBuild: build(), fetchImpl, timeoutMs: 15 })
    assert.equal(await updates.check(), null)
    assert.equal(updates.snapshot().status, 'error')
    assert.ok(updates.snapshot().error)
    assert.equal(updates.snapshot().busy, false)
  }
})

test('retry clears failure and subscriber cleanup stops notifications', async () => {
  let failed = true, signals = 0
  const updates = createAppUpdates({ currentBuild: build(), fetchImpl: async () => failed ? new Response('', { status: 503 }) : json(build()) })
  const detach = updates.subscribe(() => signals++)
  await updates.check(); detach(); const before = signals
  failed = false; await updates.check()
  assert.equal(signals, before)
  assert.equal(updates.snapshot().status, 'current')
  assert.equal(updates.snapshot().error, '')
})

test('apply requires a fresh available build, confirmation and both guard checks', async () => {
  let reloads = 0, allowed = false, guarded = false, requests = 0
  const updates = createAppUpdates({ currentBuild: build(), fetchImpl: async () => { requests++; return json(build('b')) },
    confirm: () => allowed, guard: () => { if (guarded) throw new Error('unsaved') }, reload: () => reloads++ })
  assert.equal(await updates.apply(), false)
  allowed = true; guarded = true
  assert.equal(await updates.apply(), false)
  assert.equal(requests, 1)
  guarded = false
  assert.equal(await updates.apply(), true)
  assert.equal(reloads, 1)
  assert.equal(requests, 2)
})

test('new edits during fetch or confirmation stop reload; repeated apply cannot refresh twice', async () => {
  let dirty = false, reloads = 0
  const updates = createAppUpdates({ currentBuild: build(), fetchImpl: async () => json(build('b')),
    confirm: () => { dirty = true; return true }, guard: () => { if (dirty) throw new Error('unsaved') }, reload: () => reloads++ })
  await Promise.all([updates.apply(), updates.apply()])
  assert.equal(reloads, 0)
  assert.equal(updates.snapshot().busy, false)
  assert.equal(updates.snapshot().error, 'unsaved')
})

test('unavailable update and network failure do not reload', async () => {
  for (const response of [() => json(build()), () => new Response('', { status: 503 })]) {
    const updates = createAppUpdates({ currentBuild: build(), fetchImpl: async () => response(),
      confirm: () => { throw new Error('must not confirm') }, reload: () => { throw new Error('must not reload') } })
    assert.equal(await updates.apply(), false)
  }
})

test('reload guards are in-memory, removable and checked again after confirmation', () => {
  let dirty = true
  const release = registerReloadGuard(() => dirty ? 'save first' : '')
  try {
    assert.throws(() => assertSafeToReload(), /save first/)
    dirty = false
    assert.equal(confirmVersionReload(() => false), false)
    assert.throws(() => confirmVersionReload(() => { dirty = true; return true }), /save first/)
  } finally { release() }
  assert.doesNotThrow(assertSafeToReload)
})

test('update surfaces and nginx preserve privacy and do not clear application state', async () => {
  const [updates, pwa, nginx, editor, navigation, panel] = await Promise.all([
    'app/src/shared/services/appUpdates.js', 'app/src/shared/services/pwa.js', 'ovh/nginx.conf',
    'app/src/modules/whisper/components/NoteEditor.vue', 'app/src/modules/navigation/Navigation.vue',
    'app/src/shared/components/AppUpdatePanel.vue'
  ].map((path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')))
  assert.doesNotMatch(updates, /localStorage|sessionStorage|indexedDB|document\.cookie|logout|\.clear\(/)
  assert.match(nginx, /location = \/version\.json \{[\s\S]*?try_files \$uri =404;[\s\S]*?Cache-Control "no-store"/)
  assert.match(pwa, /export function applyPwaUpdate\(\)[\s\S]*?confirmVersionReload\(\)/)
  assert.match(pwa, /controllerchange[\s\S]*?assertSafeToReload\(\)[\s\S]*?window\.location\.reload/)
  for (const source of [editor, navigation]) {
    assert.match(source, /registerReloadGuard\(/)
    assert.match(source, /releaseReloadGuard\(\)/)
  }
  assert.match(navigation, /registerReloadGuard\([\s\S]*?healthDismissalsSaving\.value/)
  assert.match(panel, /v-for="note in state.latest.notes"/)
  assert.doesNotMatch(panel, /v-html/)
})
