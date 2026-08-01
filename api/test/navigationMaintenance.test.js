import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { mapBookmark } from '../src/lib/navigation.js'
import {
  acquireNavigationTransactionLock,
  createNavigationBusyError,
  isRetryableNavigationTransactionError
} from '../src/lib/navigationTransactions.js'
import {
  haveSameNavigationIds,
  normalizeNavigationUuid,
  validateAtomicNavigationReorderPayload,
  validateNavigationIdList
} from '../src/routes/navigation.js'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const ID_D = '44444444-4444-4444-8444-444444444444'

test('navigation id lists enforce UUIDs, uniqueness and bounds', () => {
  assert.equal(normalizeNavigationUuid(ID_A.toUpperCase()), ID_A)
  assert.equal(normalizeNavigationUuid('not-a-uuid'), '')
  assert.deepEqual(validateNavigationIdList([ID_A, ID_B]).ids, [ID_A, ID_B])
  assert.equal(validateNavigationIdList([ID_A, ID_A]).code, 'duplicate_ids')
  assert.equal(validateNavigationIdList(['not-a-uuid']).code, 'invalid_id')
  assert.equal(validateNavigationIdList([], { min: 1, max: 20 }).code, 'invalid_id_count')
  assert.equal(
    validateNavigationIdList(Array(21).fill(ID_A), { min: 1, max: 20 }).code,
    'invalid_id_count'
  )
})

test('reorder set comparison detects stale, partial and foreign collections', () => {
  assert.equal(haveSameNavigationIds([ID_A, ID_B], [ID_B, ID_A]), true)
  assert.equal(haveSameNavigationIds([ID_A], [ID_A, ID_B]), false)
  assert.equal(haveSameNavigationIds([ID_A, ID_B], [ID_A, ID_A]), false)
})

test('atomic reorder payload validates exact unique group and bookmark collections', () => {
  const valid = validateAtomicNavigationReorderPayload({
    groupIds: [ID_B, ID_A],
    bookmarkOrders: [
      { groupId: ID_A, ids: [ID_C] },
      { groupId: ID_B, ids: [ID_D] }
    ]
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.groupIds, [ID_B, ID_A])
  assert.deepEqual(valid.bookmarkOrders[0], { groupId: ID_A, ids: [ID_C] })

  assert.equal(validateAtomicNavigationReorderPayload({
    groupIds: [ID_A, ID_A],
    bookmarkOrders: []
  }).code, 'group_duplicate_ids')
  assert.equal(validateAtomicNavigationReorderPayload({
    groupIds: [ID_A, ID_B],
    bookmarkOrders: [{ groupId: ID_A, ids: [] }]
  }).code, 'bookmark_group_set_mismatch')
  assert.equal(validateAtomicNavigationReorderPayload({
    groupIds: [ID_A, ID_B],
    bookmarkOrders: [
      { groupId: ID_A, ids: [ID_C] },
      { groupId: ID_B, ids: [ID_C] }
    ]
  }).code, 'duplicate_bookmark_ids')

  const largeGroupIds = Array.from(
    { length: 501 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  )
  assert.equal(validateAtomicNavigationReorderPayload({
    groupIds: [ID_A],
    bookmarkOrders: [{ groupId: ID_A, ids: largeGroupIds }]
  }).ok, true)
})

test('navigation transactions use one per-user advisory lock and map retryable errors', async () => {
  const calls = []
  await acquireNavigationTransactionLock({
    async query(sql, params) {
      calls.push({ sql, params })
    }
  }, 'user-a')

  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /SET LOCAL lock_timeout = '5s'/)
  assert.match(calls[1].sql, /pg_advisory_xact_lock/)
  assert.match(calls[1].sql, /hashtext\(\$1::text\)/)
  assert.deepEqual(calls[1].params, ['user-a'])

  for (const code of ['40001', '40P01', '55P03', '57014']) {
    assert.equal(isRetryableNavigationTransactionError({ code }), true)
  }
  assert.equal(isRetryableNavigationTransactionError({ code: '23505' }), false)

  const busy = createNavigationBusyError({ code: '40P01' })
  assert.equal(busy.statusCode, 409)
  assert.equal(busy.code, 'navigation_busy')
})

test('bookmark mapping exposes the stable health contract', () => {
  const mapped = mapBookmark({
    id: ID_A,
    group_id: ID_B,
    title: 'Example',
    url: 'https://public.example.com/',
    favicon: '',
    description: '',
    tags: [],
    display_order: 0,
    health_status: 'suspect',
    health_http_status: 404,
    health_checked_at: '2026-08-01T00:00:00.000Z',
    health_failure_count: 1,
    health_error_code: 'http_error'
  })

  assert.equal(mapped.healthStatus, 'suspect')
  assert.equal(mapped.healthHttpStatus, 404)
  assert.equal(mapped.healthCheckedAt, '2026-08-01T00:00:00.000Z')
  assert.equal(mapped.healthFailureCount, 1)
  assert.equal(mapped.healthErrorCode, 'http_error')
})

test('maintenance routes lock ownership and URL changes reset health state', async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL('../src/routes/navigation.js', import.meta.url)),
    'utf8'
  )
  const transactionSource = await fs.readFile(
    fileURLToPath(new URL('../src/lib/navigationTransactions.js', import.meta.url)),
    'utf8'
  )
  const migrationSource = await fs.readFile(
    fileURLToPath(new URL('../src/routes/migration.js', import.meta.url)),
    'utf8'
  )

  assert.match(source, /fastify\.post\('\/bookmarks\/bulk\/move'/)
  assert.match(source, /fastify\.post\('\/bookmarks\/bulk\/delete'/)
  assert.match(source, /fastify\.post\('\/bookmarks\/health-check'/)
  assert.match(source, /fastify\.post\('\/navigation\/reorder'/)
  assert.match(source, /request\.body\?\.targetGroupId/)
  assert.match(source, /FOR UPDATE/)
  assert.match(source, /code: 'stale_navigation'/)
  assert.match(source, /health_status = CASE WHEN \$9 THEN 'unchecked'/)
  assert.match(source, /AND url = \$3/)
  assert.match(source, /max: MAX_HEALTH_CHECK_IDS/)
  assert.match(source, /current\.health_failure_count/)
  assert.match(transactionSource, /pg_advisory_xact_lock/)
  assert.match(migrationSource, /withNavigationTransaction\(request\.currentUser\.id/)

  const probeIndex = source.indexOf('const probeResults = await mapWithConcurrency')
  const healthWriteIndex = source.indexOf(
    'await withNavigationTransaction(request.currentUser.id',
    probeIndex
  )
  assert.ok(probeIndex >= 0)
  assert.ok(healthWriteIndex > probeIndex)
  assert.match(source.slice(probeIndex, healthWriteIndex), /probeBookmarkUrl/)
  assert.match(source.slice(healthWriteIndex), /SELECT url, health_failure_count[\s\S]*FOR UPDATE/)
})

test('maintenance migration constrains persisted health values', async () => {
  const migration = await fs.readFile(
    fileURLToPath(new URL('../src/db/migrations/012_navigation_maintenance.sql', import.meta.url)),
    'utf8'
  )

  for (const field of [
    'health_status',
    'health_http_status',
    'health_checked_at',
    'health_failure_count',
    'health_error_code'
  ]) {
    assert.match(migration, new RegExp(field))
  }
  assert.match(migration, /'unchecked'/)
  assert.match(migration, /'broken'/)
  assert.match(migration, /health_failure_count >= 0/)
})
