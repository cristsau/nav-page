import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  assertSafeMailWorkerDatabasePoolSize,
  MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE,
  normalizeDatabasePoolMax
} from '../src/config.js'

test('mail worker keeps capacity beyond its three long-lived PostgreSQL connections', () => {
  assert.equal(MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE, 5)
  assert.equal(normalizeDatabasePoolMax(undefined, 'worker'), 8)
  assert.equal(normalizeDatabasePoolMax('', 'worker'), 8)
  assert.equal(normalizeDatabasePoolMax('2', 'worker'), 2)
  assert.equal(normalizeDatabasePoolMax('3', 'worker'), 3)
  assert.equal(normalizeDatabasePoolMax('4', 'worker'), 4)
  assert.equal(normalizeDatabasePoolMax('5', 'worker'), 5)
  assert.equal(normalizeDatabasePoolMax('32', 'worker'), 32)
  assert.equal(normalizeDatabasePoolMax('33', 'worker'), 8)
})

test('API and combined runtimes retain bounded explicit pool sizing', () => {
  assert.equal(normalizeDatabasePoolMax(undefined, 'api'), 6)
  assert.equal(normalizeDatabasePoolMax('2', 'api'), 2)
  assert.equal(normalizeDatabasePoolMax('1', 'combined'), 1)
  assert.equal(normalizeDatabasePoolMax('invalid', 'combined'), 6)
})

test('mail worker fails closed if its runtime pool invariant is bypassed', async () => {
  for (const value of [1, 2, 3, 4]) {
    assert.throws(
      () => assertSafeMailWorkerDatabasePoolSize(value),
      (error) => error?.code === 'MAIL_WORKER_DATABASE_POOL_TOO_SMALL'
    )
  }
  assert.equal(assertSafeMailWorkerDatabasePoolSize(5), 5)
  assert.equal(assertSafeMailWorkerDatabasePoolSize(8), 8)

  const source = await fs.readFile(new URL('../src/mailWorker.js', import.meta.url), 'utf8')
  assert.match(source, /assertSafeMailWorkerDatabasePoolSize\(config\.databasePoolMax\)/)
  assert.match(source, /databasePoolMax: config\.databasePoolMax/)
})
