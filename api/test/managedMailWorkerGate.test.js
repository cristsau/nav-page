import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function source(relativePath) {
  return fs.readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('retired mail worker cannot read managed files or connect to databases', async () => {
  const worker = await source('../src/mailWorker.js')
  assert.match(worker, /mailbox retired/)
  assert.doesNotMatch(worker, /^import |require\(|setInterval|applyManagedIntegrationsToRuntime|pool\.connect/m)
})

test('managed credential and encryption-key reads are guarded on both sides of disk access', async () => {
  const [oauth, crypto] = await Promise.all([
    source('../src/lib/emailOauth2.js'),
    source('../src/lib/emailCrypto.js')
  ])
  assert.ok((oauth.match(/assertManagedCredentialReadStable\(runtimeConfig\)/g) || []).length >= 6)
  assert.ok((crypto.match(/assertManagedMailUpdateAvailable\(runtimeConfig\)/g) || []).length >= 2)
})
