import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function source(relativePath) {
  return fs.readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('mail worker gates startup and refresh before applying managed mail files', async () => {
  const worker = await source('../src/mailWorker.js')
  const initialGate = worker.indexOf('await assertManagedMailUpdateAvailable(config)')
  const initialApply = worker.indexOf('const initialIntegration = await applyManagedIntegrationsToRuntime()')
  const refreshGate = worker.indexOf('void assertManagedMailUpdateAvailable(config)')
  const refreshApply = worker.indexOf('applyManagedIntegrationsToRuntime()', refreshGate)
  assert.ok(initialGate >= 0 && initialGate < initialApply)
  assert.ok(refreshGate >= 0 && refreshGate < refreshApply)
  assert.match(worker, /MANAGED_MAIL_UPDATE_IN_PROGRESS/)
  assert.match(worker, /MAIL_UPDATE_STALE_MS = 30_000/)
  assert.match(worker, /await suspendEmailRuntime\(\{ reason: 'MANAGED_MAIL_UPDATE_STALE' \}\)/)
  assert.match(worker, /process\.exit\(1\)/)
})

test('managed credential and encryption-key reads are guarded on both sides of disk access', async () => {
  const [oauth, crypto] = await Promise.all([
    source('../src/lib/emailOauth2.js'),
    source('../src/lib/emailCrypto.js')
  ])
  assert.ok((oauth.match(/assertManagedCredentialReadStable\(runtimeConfig\)/g) || []).length >= 6)
  assert.ok((crypto.match(/assertManagedMailUpdateAvailable\(runtimeConfig\)/g) || []).length >= 2)
})
