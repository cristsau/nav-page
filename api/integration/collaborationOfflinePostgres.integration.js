import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_collaboration_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const EDITOR_ID = '22222222-2222-4222-8222-222222222222'
const VIEWER_ID = '33333333-3333-4333-8333-333333333333'
const NOTE_ID = '44444444-4444-4444-8444-444444444444'
const ENCRYPTED_NOTE_ID = '55555555-5555-4555-8555-555555555555'
const OFFLINE_COMMENT_ID = '66666666-6666-4666-8666-666666666666'
const OFFLINE_OPERATION_ID = '77777777-7777-4777-8777-777777777777'

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_COLLABORATION_INTEGRATION_TEST, 'true')
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

let pool
let getNoteAccess
let app
let config
let createSessionToken
let hashSessionToken

before(async () => {
  const [appModule, configModule, databaseModule, authModule, collaborationModule] = await Promise.all([
    import('../src/app.js'),
    import('../src/config.js'),
    import('../src/db/index.js'),
    import('../src/lib/auth.js'),
    import('../src/lib/noteCollaboration.js')
  ])
  config = configModule.config
  pool = databaseModule.pool
  createSessionToken = authModule.createSessionToken
  hashSessionToken = authModule.hashSessionToken
  getNoteAccess = collaborationModule.getNoteAccess
  app = appModule.createApp()
  await app.ready()
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await pool.query(
    `
      INSERT INTO users (id, username, password_hash, role, status, approved_at)
      VALUES
        ($1, 'owner', 'not-a-real-password', 'admin', 'approved', NOW()),
        ($2, 'editor', 'not-a-real-password', 'user', 'approved', NOW()),
        ($3, 'viewer', 'not-a-real-password', 'user', 'approved', NOW())
    `,
    [OWNER_ID, EDITOR_ID, VIEWER_ID]
  )
  await pool.query(
    `
      INSERT INTO notes (
        id, user_id, number_id, type, title, content,
        encrypted, password_hash, tags, attachments
      ) VALUES
        ($1, $2, 7000, 'memo', '协作恢复清单', '先做隔离恢复', FALSE, '', '[]'::jsonb, '[]'::jsonb),
        ($3, $2, 7001, 'memo', '加密私密记录', 'ciphertext', TRUE, 'hash', '[]'::jsonb, '[]'::jsonb)
    `,
    [NOTE_ID, OWNER_ID, ENCRYPTED_NOTE_ID]
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
      ) VALUES ($1, $2, $3, '127.0.0.1', 'collaboration-integration', NOW() + INTERVAL '1 day')
    `,
    [randomUUID(), userId, hashSessionToken(token)]
  )
  return { cookie: `${config.sessionCookieName}=${token}` }
}

function apiRequest(method, path, session, payload) {
  const request = {
    method,
    url: `/api${path}`,
    headers: {
      cookie: session.cookie,
      origin: 'http://localhost:5174'
    }
  }
  if (payload !== undefined) request.payload = payload
  return app.inject(request)
}

test('owner, editor and viewer access is ranked and encrypted notes reject collaboration', async () => {
  await pool.query(
    `
      INSERT INTO note_collaborators (note_id, user_id, role, invited_by)
      VALUES ($1, $2, 'editor', $3), ($1, $4, 'viewer', $3)
    `,
    [NOTE_ID, EDITOR_ID, OWNER_ID, VIEWER_ID]
  )

  const owner = await getNoteAccess(pool.query.bind(pool), OWNER_ID, NOTE_ID)
  const editor = await getNoteAccess(pool.query.bind(pool), EDITOR_ID, NOTE_ID)
  const viewer = await getNoteAccess(pool.query.bind(pool), VIEWER_ID, NOTE_ID)
  assert.equal(owner.access_role, 'owner')
  assert.equal(editor.access_role, 'editor')
  assert.equal(viewer.access_role, 'viewer')

  await assert.rejects(
    pool.query(
      `INSERT INTO note_collaborators (note_id, user_id, role, invited_by)
       VALUES ($1, $2, 'editor', $3)`,
      [ENCRYPTED_NOTE_ID, EDITOR_ID, OWNER_ID]
    ),
    (error) => error?.code === '23514'
  )
  await assert.rejects(
    pool.query(
      `INSERT INTO note_collaborators (note_id, user_id, role, invited_by)
       VALUES ($1, $2, 'editor', $2)`,
      [NOTE_ID, OWNER_ID]
    ),
    (error) => error?.code === '23514'
  )
})

test('member and comment events retain the audience required for cross-device sync', async () => {
  await pool.query(
    `INSERT INTO note_collaborators (note_id, user_id, role, invited_by)
     VALUES ($1, $2, 'commenter', $3)`,
    [NOTE_ID, EDITOR_ID, OWNER_ID]
  )
  const comment = await pool.query(
    `
      INSERT INTO note_comments (note_id, user_id, body, selection)
      VALUES ($1, $2, '请确认恢复哈希', '{"from":1,"to":5,"text":"恢复"}'::jsonb)
      RETURNING id
    `,
    [NOTE_ID, EDITOR_ID]
  )
  await pool.query(
    `
      UPDATE note_comments
      SET status = 'resolved', resolved_by = $2, resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `,
    [comment.rows[0].id, OWNER_ID]
  )
  await pool.query(
    'DELETE FROM note_collaborators WHERE note_id = $1 AND user_id = $2',
    [NOTE_ID, EDITOR_ID]
  )

  const { rows } = await pool.query(
    `
      SELECT event_kind, entity_id, audience_user_ids, payload
      FROM note_sync_events
      WHERE entity_id IN ($1, $2)
      ORDER BY id
    `,
    [EDITOR_ID, comment.rows[0].id]
  )
  assert.ok(rows.some((row) => row.event_kind === 'member.upsert'))
  assert.ok(rows.some((row) => row.event_kind === 'comment.upsert'))
  const removed = rows.find((row) => row.event_kind === 'member.delete')
  assert.ok(removed)
  assert.ok(removed.audience_user_ids.includes(OWNER_ID))
  assert.ok(removed.audience_user_ids.includes(EDITOR_ID))
  assert.equal(removed.payload.deleted, true)
})

test('delete events survive note cascade and preserve the last known audience', async () => {
  await pool.query(
    `INSERT INTO note_collaborators (note_id, user_id, role, invited_by)
     VALUES ($1, $2, 'editor', $3)`,
    [NOTE_ID, EDITOR_ID, OWNER_ID]
  )
  await pool.query('DELETE FROM notes WHERE id = $1', [NOTE_ID])
  const { rows } = await pool.query(
    `
      SELECT note_id, event_kind, entity_id, audience_user_ids, payload
      FROM note_sync_events
      WHERE event_kind = 'note.delete' AND entity_id = $1
      ORDER BY id DESC
      LIMIT 1
    `,
    [NOTE_ID]
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].note_id, null)
  assert.ok(rows[0].audience_user_ids.includes(OWNER_ID))
  assert.ok(rows[0].audience_user_ids.includes(EDITOR_ID))
  assert.equal(rows[0].payload.deleted, true)
})

test('collaboration API enforces owner, editor and viewer permissions', async () => {
  const ownerSession = await seedSession(OWNER_ID)
  const editorSession = await seedSession(EDITOR_ID)
  const viewerSession = await seedSession(VIEWER_ID)

  const inviteEditor = await apiRequest(
    'POST',
    `/collaboration/notes/${NOTE_ID}/members`,
    ownerSession,
    { username: 'editor', role: 'editor' }
  )
  assert.equal(inviteEditor.statusCode, 201)
  assert.equal(inviteEditor.json().member.role, 'editor')

  const inviteViewer = await apiRequest(
    'POST',
    `/collaboration/notes/${NOTE_ID}/members`,
    ownerSession,
    { username: 'viewer', role: 'viewer' }
  )
  assert.equal(inviteViewer.statusCode, 201)
  assert.equal(inviteViewer.json().member.role, 'viewer')

  const editorDetail = await apiRequest(
    'GET',
    `/collaboration/notes/${NOTE_ID}`,
    editorSession
  )
  assert.equal(editorDetail.statusCode, 200)
  assert.equal(editorDetail.json().note.accessRole, 'editor')

  const editorComment = await apiRequest(
    'POST',
    `/collaboration/notes/${NOTE_ID}/comments`,
    editorSession,
    { body: 'API 集成测试评论', blockId: 'block-1' }
  )
  assert.equal(editorComment.statusCode, 201)
  assert.equal(editorComment.json().comment.body, 'API 集成测试评论')

  const viewerComment = await apiRequest(
    'POST',
    `/collaboration/notes/${NOTE_ID}/comments`,
    viewerSession,
    { body: '不应写入的评论' }
  )
  assert.equal(viewerComment.statusCode, 403)

  const viewerMetadata = await apiRequest(
    'PATCH',
    `/collaboration/notes/${NOTE_ID}/metadata`,
    viewerSession,
    { title: '不应修改的标题' }
  )
  assert.equal(viewerMetadata.statusCode, 403)

  const stored = await pool.query(
    'SELECT title FROM notes WHERE id = $1',
    [NOTE_ID]
  )
  assert.equal(stored.rows[0].title, '协作恢复清单')
})

test('offline mutation receipts replay once and reject operation-id payload conflicts', async () => {
  await pool.query(
    `INSERT INTO note_collaborators (note_id, user_id, role, invited_by)
     VALUES ($1, $2, 'editor', $3)`,
    [NOTE_ID, EDITOR_ID, OWNER_ID]
  )
  const editorSession = await seedSession(EDITOR_ID)
  const mutation = {
    operationId: OFFLINE_OPERATION_ID,
    kind: 'comment.create',
    payload: {
      id: OFFLINE_COMMENT_ID,
      noteId: NOTE_ID,
      body: '离线队列只创建一次',
      blockId: 'offline-block'
    }
  }

  const first = await apiRequest(
    'POST',
    '/collaboration/sync/mutations',
    editorSession,
    { mutations: [mutation] }
  )
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().results[0].status, 201)
  assert.equal(first.json().results[0].replayed, false)

  const replay = await apiRequest(
    'POST',
    '/collaboration/sync/mutations',
    editorSession,
    { mutations: [mutation] }
  )
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.json().results[0].status, 201)
  assert.equal(replay.json().results[0].replayed, true)

  const stored = await pool.query(
    'SELECT COUNT(*)::integer AS count FROM note_comments WHERE id = $1',
    [OFFLINE_COMMENT_ID]
  )
  assert.equal(stored.rows[0].count, 1)

  const conflict = await apiRequest(
    'POST',
    '/collaboration/sync/mutations',
    editorSession,
    {
      mutations: [{
        ...mutation,
        payload: { ...mutation.payload, body: '相同 ID 的不同内容' }
      }]
    }
  )
  assert.equal(conflict.statusCode, 200)
  assert.equal(conflict.json().results[0].status, 409)
  assert.equal(conflict.json().results[0].code, 'offline_operation_conflict')
})
