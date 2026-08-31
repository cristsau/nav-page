import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_workspace_database_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'

const ids = {
  title: '30000000-0000-4000-8000-000000000001',
  score: '30000000-0000-4000-8000-000000000002',
  status: '30000000-0000-4000-8000-000000000003',
  relation: '30000000-0000-4000-8000-000000000004',
  active: '40000000-0000-4000-8000-000000000001',
  done: '40000000-0000-4000-8000-000000000002'
}

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_WORKSPACE_DATABASE_INTEGRATION_TEST, 'true')
  const databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(
    decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')),
    EXPECTED_DATABASE_NAME
  )
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }
}

assertIsolatedDatabaseTarget()

let app
let config
let pool
let createSessionToken
let hashSessionToken

before(async () => {
  const [appModule, configModule, databaseModule, authModule] = await Promise.all([
    import('../src/app.js'),
    import('../src/config.js'),
    import('../src/db/index.js'),
    import('../src/lib/auth.js')
  ])
  config = configModule.config
  pool = databaseModule.pool
  createSessionToken = authModule.createSessionToken
  hashSessionToken = authModule.hashSessionToken
  app = appModule.createApp()
  await app.ready()
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await pool.query(
    `
      INSERT INTO users (id, username, password_hash, role, status, approved_at)
      VALUES
        ($1, 'workspace-owner', 'not-a-real-password', 'user', 'approved', NOW()),
        ($2, 'workspace-other', 'not-a-real-password', 'user', 'approved', NOW())
    `,
    [OWNER_ID, OTHER_ID]
  )
})

after(async () => {
  await app?.close()
  await pool?.end()
})

async function seedSession(userId) {
  const token = createSessionToken()
  await pool.query(
    `
      INSERT INTO sessions (
        id, user_id, token_hash, ip_address, user_agent, expires_at
      ) VALUES ($1, $2, $3, '127.0.0.1', 'workspace-database-integration', NOW() + INTERVAL '1 day')
    `,
    [randomUUID(), userId, hashSessionToken(token)]
  )
  return { cookie: `${config.sessionCookieName}=${token}` }
}

async function apiRequest(method, path, session, payload) {
  const request = {
    method,
    url: `/api${path}`,
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost:5174'
    }
  }
  if (payload !== undefined) request.payload = payload
  const response = await app.inject(request)
  let body = null
  try {
    body = response.json()
  } catch {
    body = response.body
  }
  return { response, body }
}

function expectStatus(result, statusCode) {
  assert.equal(
    result.response.statusCode,
    statusCode,
    `${result.response.statusCode}: ${JSON.stringify(result.body)}`
  )
  return result.body
}

async function createDatabase(session, {
  name,
  properties,
  views
}) {
  return expectStatus(await apiRequest('POST', '/workspace-databases', session, {
    name,
    properties,
    ...(views ? { views } : {})
  }), 201)
}

test('ownership is enforced by API and composite relation foreign keys', async () => {
  const owner = await seedSession(OWNER_ID)
  const other = await seedSession(OTHER_ID)
  const ownerTarget = await createDatabase(owner, {
    name: 'Owner target',
    properties: [{ id: ids.title, name: '名称', type: 'title', config: {} }]
  })
  const targetRow = expectStatus(await apiRequest(
    'POST',
    `/workspace-databases/${ownerTarget.database.id}/rows`,
    owner,
    { title: 'Owner row', values: {} }
  ), 201).row

  const hidden = await apiRequest(
    'GET',
    `/workspace-databases/${ownerTarget.database.id}`,
    other
  )
  assert.equal(hidden.response.statusCode, 404)

  const ownerSource = await createDatabase(owner, {
    name: 'Owner source',
    properties: [{ name: '名称', type: 'title', config: {} }]
  })
  const ownerSourceTitle = ownerSource.properties.find((property) => property.type === 'title')
  const ownerSourceRow = expectStatus(await apiRequest(
    'POST',
    `/workspace-databases/${ownerSource.database.id}/rows`,
    owner,
    { title: 'Owner source row', values: {} }
  ), 201).row

  await assert.rejects(
    pool.query(
      `
        INSERT INTO workspace_database_relations (
          source_row_id, source_database_id, source_property_id,
          target_row_id, target_database_id, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        ownerSourceRow.id,
        ownerSource.database.id,
        ids.title,
        targetRow.id,
        ownerTarget.database.id,
        OWNER_ID
      ]
    ),
    (error) => error?.code === '23503'
  )

  await assert.rejects(
    pool.query(
      `
        INSERT INTO workspace_database_relations (
          source_row_id, source_database_id, source_property_id,
          target_row_id, target_database_id, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        ownerSourceRow.id,
        ownerSource.database.id,
        ownerSourceTitle.id,
        targetRow.id,
        ownerSource.database.id,
        OWNER_ID
      ]
    ),
    (error) => error?.code === '23503'
  )

  const otherSource = await createDatabase(other, {
    name: 'Other source',
    properties: [{ name: '名称', type: 'title', config: {} }]
  })
  const otherTitle = otherSource.properties.find((property) => property.type === 'title')
  const otherRow = expectStatus(await apiRequest(
    'POST',
    `/workspace-databases/${otherSource.database.id}/rows`,
    other,
    { title: 'Other row', values: {} }
  ), 201).row

  await assert.rejects(
    pool.query(
      `
        INSERT INTO workspace_database_relations (
          source_row_id, source_database_id, source_property_id,
          target_row_id, target_database_id, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        otherRow.id,
        otherSource.database.id,
        otherTitle.id,
        targetRow.id,
        ownerTarget.database.id,
        OTHER_ID
      ]
    ),
    (error) => error?.code === '23503'
  )

  await assert.rejects(
    pool.query(
      `
        INSERT INTO workspace_database_relations (
          source_row_id, source_database_id, source_property_id,
          target_row_id, target_database_id, user_id
        ) VALUES ($1, $2, $3, $1, $2, $4)
      `,
      [otherRow.id, otherSource.database.id, ids.title, OTHER_ID]
    ),
    (error) => error?.code === '23503' || error?.code === '23514'
  )
})

test('relations, backlinks, archive/restore and typed view filter/sort are consistent', async () => {
  const owner = await seedSession(OWNER_ID)
  const target = await createDatabase(owner, {
    name: 'Projects',
    properties: [
      { id: ids.title, name: '名称', type: 'title', config: {} },
      { id: ids.score, name: '分数', type: 'number', config: { format: 'number' } },
      {
        id: ids.status,
        name: '状态',
        type: 'status',
        config: {
          options: [
            { id: ids.active, name: '进行中', color: 'blue' },
            { id: ids.done, name: '完成', color: 'green' }
          ]
        }
      }
    ],
    views: [{
      name: '进行中',
      type: 'table',
      config: {
        filters: [{ propertyId: ids.status, operator: 'equals', value: ids.active }],
        sorts: [{ propertyId: ids.score, direction: 'desc' }],
        visiblePropertyIds: [ids.title, ids.score, ids.status]
      }
    }]
  })
  const first = expectStatus(await apiRequest(
    'POST', `/workspace-databases/${target.database.id}/rows`, owner,
    { title: '低分', values: { [ids.score]: 2, [ids.status]: ids.active } }
  ), 201).row
  const second = expectStatus(await apiRequest(
    'POST', `/workspace-databases/${target.database.id}/rows`, owner,
    { title: '高分', values: { [ids.score]: 9, [ids.status]: ids.active } }
  ), 201).row
  await apiRequest(
    'POST', `/workspace-databases/${target.database.id}/rows`, owner,
    { title: '已完成', values: { [ids.score]: 100, [ids.status]: ids.done } }
  )

  const source = await createDatabase(owner, {
    name: 'Tasks',
    properties: [
      { name: '名称', type: 'title', config: {} },
      {
        id: ids.relation,
        name: '项目',
        type: 'relation',
        config: { targetDatabaseId: target.database.id, allowMultiple: true }
      }
    ]
  })
  const sourceRow = expectStatus(await apiRequest(
    'POST', `/workspace-databases/${source.database.id}/rows`, owner,
    { title: '关联任务', values: { [ids.relation]: [second.id] } }
  ), 201).row

  const viewRows = expectStatus(await apiRequest(
    'GET',
    `/workspace-databases/${target.database.id}/rows?viewId=${target.views[0].id}`,
    owner
  ), 200)
  assert.deepEqual(viewRows.rows.map((row) => row.title), ['高分', '低分'])
  assert.equal(viewRows.backlinksByRow[second.id].length, 1)
  assert.equal(viewRows.backlinksByRow[first.id].length, 0)

  expectStatus(await apiRequest(
    'DELETE', `/workspace-databases/${source.database.id}/rows/${sourceRow.id}`, owner
  ), 200)
  const archivedBacklink = expectStatus(await apiRequest(
    'GET', `/workspace-databases/${target.database.id}/rows`, owner
  ), 200)
  assert.equal(archivedBacklink.backlinksByRow[second.id].length, 0)

  expectStatus(await apiRequest(
    'POST', `/workspace-databases/${source.database.id}/rows/${sourceRow.id}/restore`, owner, {}
  ), 200)
  const restoredBacklink = expectStatus(await apiRequest(
    'GET', `/workspace-databases/${target.database.id}/rows`, owner
  ), 200)
  assert.equal(restoredBacklink.backlinksByRow[second.id].length, 1)
})

test('schema edits reject used options and transactionally repair stale view config', async () => {
  const owner = await seedSession(OWNER_ID)
  const database = await createDatabase(owner, {
    name: 'Schema edits',
    properties: [
      { id: ids.title, name: '名称', type: 'title', config: {} },
      { id: ids.score, name: '分数', type: 'number', config: { format: 'number' } },
      {
        id: ids.status,
        name: '状态',
        type: 'status',
        config: {
          options: [
            { id: ids.active, name: '进行中', color: 'blue' },
            { id: ids.done, name: '完成', color: 'green' }
          ]
        }
      }
    ],
    views: [{
      name: '状态看板',
      type: 'board',
      config: {
        filters: [{ propertyId: ids.status, operator: 'equals', value: ids.done }],
        sorts: [{ propertyId: ids.score, direction: 'desc' }],
        visiblePropertyIds: [ids.title, ids.score, ids.status],
        groupByPropertyId: ids.status
      }
    }]
  })
  expectStatus(await apiRequest(
    'POST', `/workspace-databases/${database.database.id}/rows`, owner,
    { title: 'Uses done', values: { [ids.status]: ids.done, [ids.score]: 5 } }
  ), 201)

  const removeUsedOption = await apiRequest(
    'PATCH',
    `/workspace-databases/${database.database.id}/properties/${ids.status}`,
    owner,
    {
      config: {
        options: [{ id: ids.active, name: '进行中', color: 'blue' }]
      }
    }
  )
  assert.equal(removeUsedOption.response.statusCode, 409)
  assert.equal(removeUsedOption.body.code, 'workspace_database_property_option_in_use')

  expectStatus(await apiRequest(
    'DELETE',
    `/workspace-databases/${database.database.id}/properties/${ids.status}`,
    owner
  ), 200)
  const repaired = expectStatus(await apiRequest(
    'GET', `/workspace-databases/${database.database.id}`, owner
  ), 200)
  const view = repaired.views[0]
  assert.deepEqual(view.config.filters, [])
  assert.equal(view.config.groupByPropertyId, null)
  assert.ok(!view.config.visiblePropertyIds.includes(ids.status))
  assert.deepEqual(view.config.sorts, [{ propertyId: ids.score, direction: 'desc' }])
})

test('concurrent row creation serializes positions and the 5000 cap is explicit', async () => {
  const owner = await seedSession(OWNER_ID)
  const database = await createDatabase(owner, {
    name: 'Capacity',
    properties: [{ id: ids.title, name: '名称', type: 'title', config: {} }]
  })
  const created = await Promise.all([
    apiRequest('POST', `/workspace-databases/${database.database.id}/rows`, owner, { title: 'A', values: {} }),
    apiRequest('POST', `/workspace-databases/${database.database.id}/rows`, owner, { title: 'B', values: {} })
  ])
  const positions = created.map((result) => BigInt(expectStatus(result, 201).row.position))
  assert.equal(new Set(positions.map(String)).size, 2)

  await pool.query(
    `
      INSERT INTO workspace_database_rows (database_id, user_id, title, position)
      SELECT $1, $2, 'Bulk ' || value, 100000 + value
      FROM generate_series(1, 5001) AS value
    `,
    [database.database.id, OWNER_ID]
  )
  const capped = expectStatus(await apiRequest(
    'GET', `/workspace-databases/${database.database.id}/rows`, owner
  ), 200)
  assert.equal(capped.rows.length, 5000)
  assert.equal(capped.limit, 5000)
  assert.equal(capped.hasMore, true)
  assert.equal(capped.truncated, true)
})
