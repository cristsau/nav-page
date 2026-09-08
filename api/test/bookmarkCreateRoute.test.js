import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import navigationRoutes from '../src/routes/navigation.js'
import { pool } from '../src/db/index.js'

// Route contract test only, not a substitute for PostgreSQL locking tests.
test('bookmark creation returns authoritative duplicate outcomes and preserves URL identity and ownership', async (t) => {
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const groupId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const rows = []
  const statements = []
  let connections = 0
  t.mock.method(pool, 'query', async (sql, params) => {
    assert.match(sql, /FROM nav_groups/)
    assert.equal(params[1], userId)
    return { rows: params[0] === groupId ? [{ id: groupId }] : [] }
  })
  t.mock.method(pool, 'connect', async () => {
    connections++
    return {
      release() {},
      async query(sql, params) {
        statements.push(sql.trim())
        if (/pg_advisory_xact_lock/.test(sql)) assert.deepEqual(params, [userId])
        if (/FROM nav_groups/.test(sql)) {
          assert.deepEqual(params, [groupId, userId]); return { rows: [{ id: groupId }] }
        }
        if (/SELECT \*/.test(sql) && /FROM nav_bookmarks/.test(sql)) {
          assert.match(sql, /AND url = \$3/)
          assert.deepEqual(params.slice(0, 2), [userId, groupId])
          return { rows: rows.filter((row) => row.url === params[2]) }
        }
        if (/MAX\(display_order\)/.test(sql)) return { rows: [{ next_order: rows.length }] }
        if (/INSERT INTO nav_bookmarks/.test(sql)) {
          const [user_id, group_id, title, url] = params
          const row = { id: `created-${rows.length}`, user_id, group_id, title, url }
          rows.push(row); return { rows: [row] }
        }
        assert.ok(/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql), 'unexpected SQL')
        return { rows: [] }
      }
    }
  })
  const app = Fastify()
  app.decorate('requireAuth', async (request) => { request.currentUser = { id: userId } })
  await app.register(navigationRoutes)
  try {
    const create = (url, overrides = {}) => app.inject({ method: 'POST', url: '/bookmarks', payload: { groupId, title: 'Synthetic', url, deduplicate: true, ...overrides } })
    const first = await create('HTTPS://EXAMPLE.test:443/Guide?Key=VALUE#Part')
    assert.equal(first.statusCode, 201)
    assert.equal(first.json().created, true)
    const duplicate = await create('https://example.test/Guide?Key=VALUE#Part')
    assert.equal(duplicate.statusCode, 200)
    assert.equal(duplicate.json().created, false)
    assert.equal(first.json().bookmark.id, duplicate.json().bookmark.id)
    for (const variant of ['/guide?Key=VALUE#Part', '/Guide?Key=value#Part', '/Guide?Key=VALUE#part', '/Guide/?Key=VALUE#Part']) {
      assert.equal((await create(`https://example.test${variant}`)).statusCode, 201)
    }
    assert.equal(rows.length, 5)
    const beforeRejected = connections
    assert.equal((await create('https://user:synthetic@example.test/')).statusCode, 400)
    assert.equal((await create('https://example.test/', { groupId: 'foreign-group' })).statusCode, 404)
    assert.equal(connections, beforeRejected, 'invalid URL / foreign group must not start writes')
    assert.ok(statements.indexOf('BEGIN') < statements.findIndex((sql) => /pg_advisory_xact_lock/.test(sql)))
    assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 6)
  } finally { await app.close() }
})
