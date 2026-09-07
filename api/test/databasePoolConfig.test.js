import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  assertSafeMailWorkerDatabasePoolSize,
  MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE,
  normalizeDatabasePoolMax,
  requiredMailWorkerDatabasePoolSize
} from '../src/config.js'

test('mail worker keeps capacity for two mailbox leases, wake listeners and transient work', () => {
  assert.equal(MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE, 8)
  assert.equal(requiredMailWorkerDatabasePoolSize(0), 8)
  assert.equal(requiredMailWorkerDatabasePoolSize(1), 8)
  assert.equal(requiredMailWorkerDatabasePoolSize(2), 8)
  assert.equal(requiredMailWorkerDatabasePoolSize(4), 12)
  assert.equal(normalizeDatabasePoolMax(undefined, 'worker'), 12)
  assert.equal(normalizeDatabasePoolMax('', 'worker'), 12)
  assert.equal(normalizeDatabasePoolMax('2', 'worker'), 2)
  assert.equal(normalizeDatabasePoolMax('3', 'worker'), 3)
  assert.equal(normalizeDatabasePoolMax('4', 'worker'), 4)
  assert.equal(normalizeDatabasePoolMax('5', 'worker'), 5)
  assert.equal(normalizeDatabasePoolMax('32', 'worker'), 32)
  assert.equal(normalizeDatabasePoolMax('33', 'worker'), 12)
})

test('API and combined runtimes retain bounded explicit pool sizing', () => {
  assert.equal(normalizeDatabasePoolMax(undefined, 'api'), 6)
  assert.equal(normalizeDatabasePoolMax('2', 'api'), 2)
  assert.equal(normalizeDatabasePoolMax('1', 'combined'), 1)
  assert.equal(normalizeDatabasePoolMax('invalid', 'combined'), 12)
})

test('mail worker fails closed if its runtime or active-account pool invariant is bypassed', async () => {
  for (const value of [1, 2, 3, 4, 5, 6, 7]) {
    assert.throws(
      () => assertSafeMailWorkerDatabasePoolSize(value),
      (error) => error?.code === 'MAIL_WORKER_DATABASE_POOL_TOO_SMALL'
    )
  }
  assert.equal(assertSafeMailWorkerDatabasePoolSize(8), 8)
  assert.throws(
    () => assertSafeMailWorkerDatabasePoolSize(9, 3),
    (error) => error?.code === 'MAIL_WORKER_DATABASE_POOL_TOO_SMALL' && error?.required === 10
  )
  assert.equal(assertSafeMailWorkerDatabasePoolSize(10, 3), 10)

  const source = await fs.readFile(new URL('../src/mailWorker.js', import.meta.url), 'utf8')
  assert.match(source, /mailbox retired/)
  assert.doesNotMatch(source, /^import |setInterval|pool\.connect/m)
})

test('combined runtime controller enforces the same active-mailbox pool budget', async () => {
  const source = await fs.readFile(new URL('../src/lib/emailRuntimeController.js', import.meta.url), 'utf8')
  assert.match(source, /if \(workerRuntimeEnabled\)/)
  assert.match(source, /assertSafeMailWorkerDatabasePoolSize\([\s\S]*?runtimeConfig\.databasePoolMax,[\s\S]*?mailRuntimes\.filter\(\(item\) => item\.emailIngestEnabled\)\.length/)
})
