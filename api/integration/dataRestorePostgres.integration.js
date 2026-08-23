import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import test, { after, before, beforeEach } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const EXPECTED_DATABASE_NAME = 'nav_restore_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const CORRECT_PASSWORD = 'Correct Horse Battery Staple 2026!'
const WRONG_PASSWORD = 'This password is deliberately wrong'
const RESTORE_CONFIRMATION = '恢复'
const RESTORE_BODY_LIMIT = 16 * 1024 * 1024
const RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000
const RESTORE_LOCK_TABLES = Object.freeze([
  'custom_search_engines',
  'media_assets',
  'nav_bookmarks',
  'nav_groups',
  'note_reminders',
  'note_shares',
  'notes',
  'user_settings'
])
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BASELINE_A_GROUP_ID = '11111111-1111-4111-8111-111111111111'
const BASELINE_A_NOTE_ID = '22222222-2222-4222-8222-222222222222'
const BASELINE_B_GROUP_ID = '33333333-3333-4333-8333-333333333333'
const BASELINE_B_NOTE_ID = '44444444-4444-4444-8444-444444444444'
const TEST_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5174'

function assertIsolatedDatabaseTarget() {
  assert.equal(
    process.env.NODE_ENV,
    'test',
    'PostgreSQL restore integration tests require NODE_ENV=test'
  )
  assert.equal(
    process.env.NAV_RESTORE_INTEGRATION_TEST,
    'true',
    'PostgreSQL restore integration tests require NAV_RESTORE_INTEGRATION_TEST=true'
  )

  let databaseUrl
  try {
    databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  } catch {
    assert.fail('PostgreSQL restore integration tests require a valid DATABASE_URL')
  }

  assert.ok(
    ['postgres:', 'postgresql:'].includes(databaseUrl.protocol),
    'DATABASE_URL must use PostgreSQL'
  )
  assert.ok(
    ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()),
    'destructive restore integration fixtures are restricted to localhost or 127.0.0.1'
  )
  assert.equal(
    decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')),
    EXPECTED_DATABASE_NAME,
    `destructive restore integration fixtures require database ${EXPECTED_DATABASE_NAME}`
  )
  for (const redirectParameter of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(
      databaseUrl.searchParams.has(redirectParameter),
      false,
      `DATABASE_URL must not override its target through ${redirectParameter}`
    )
  }
}

// Fail closed before importing any application module that owns a database pool.
assertIsolatedDatabaseTarget()

let app
let config
let pool
let createMediaUserPrefix
let createSessionToken
let hashPassword
let hashSessionToken
let passwordHash

function fixtureUuid(namespace, index) {
  const prefix = Number(namespace).toString(16).padStart(8, '0').slice(-8)
  const suffix = Number(index).toString(16).padStart(12, '0').slice(-12)
  return `${prefix}-0000-4000-8000-${suffix}`
}

function json(response) {
  return response.json()
}

function flipTokenCharacter(value) {
  const token = String(value || '')
  assert.ok(token.length > 1, 'test fixture token must not be empty')
  const last = token.at(-1)
  return `${token.slice(0, -1)}${last === '0' ? '1' : '0'}`
}

function mediaFixture(userId, index, namespace = 70) {
  const upstreamId = `${createMediaUserPrefix(userId)}restore-${namespace}-${index}.webp`
  const origin = new URL(config.imgBedBaseUrl).origin
  return {
    id: fixtureUuid(namespace, index),
    upstreamId,
    url: `${origin}/file/${upstreamId}`,
    name: `restore-${namespace}-${index}.webp`,
    mime: 'image/webp',
    size: 1024 + index,
    createdAt: '2026-08-23T00:00:00.000Z',
    source: 'reconciled',
    retention: 'auto',
    state: 'active'
  }
}

function backupEnvelope(data, { exportedAt = '2026-08-23T00:00:00.000Z' } = {}) {
  const attachments = data.notes.reduce(
    (total, note) => total + (Array.isArray(note.attachments) ? note.attachments.length : 0),
    0
  )
  const counts = {
    groups: data.groups.length,
    bookmarks: data.bookmarks.length,
    notes: data.notes.length,
    customEngines: data.customEngines.length,
    shares: data.shares.length,
    settings: data.settings.length,
    mediaAssets: data.mediaAssets.length,
    attachments
  }
  counts.totalRecords = (
    counts.groups
    + counts.bookmarks
    + counts.notes
    + counts.customEngines
    + counts.shares
    + counts.settings
    + counts.mediaAssets
  )

  return {
    source: 'cloud-backup',
    schema: 'domo-nav-backup',
    version: 1,
    exportedAt,
    manifest: {
      schema: 'domo-nav-backup',
      version: 1,
      source: 'postgresql',
      scope: 'authenticated-user',
      counts
    },
    data
  }
}

function normalBackup(userId = USER_A_ID) {
  const groupId = fixtureUuid(31, 1)
  const explicitNoteId = fixtureUuid(33, 1)
  const automaticNoteId = fixtureUuid(33, 2)
  return backupEnvelope({
    groups: [{
      id: groupId,
      name: 'Restored group',
      icon: 'folder',
      color: '#5e6ad2',
      order: 1,
      collapsed: false
    }],
    bookmarks: [{
      id: fixtureUuid(32, 1),
      groupId,
      title: 'Restored bookmark',
      url: 'https://example.test/restored',
      favicon: '',
      description: 'PostgreSQL integration fixture',
      tags: ['restore'],
      order: 1
    }],
    notes: [
      {
        id: explicitNoteId,
        numberId: 4000,
        type: 'memo',
        title: 'Explicit number',
        content: 'restored note one',
        encrypted: false,
        password: '',
        pinned: true,
        tags: ['restore'],
        attachments: [],
        completed: false
      },
      {
        id: automaticNoteId,
        type: 'memo',
        title: 'Allocated number',
        content: 'restored note two',
        encrypted: false,
        password: '',
        pinned: false,
        tags: [],
        attachments: [],
        completed: false
      }
    ],
    customEngines: [{
      id: fixtureUuid(34, 1),
      name: 'Restored search',
      icon: 'R',
      url: 'https://example.test/search?q={query}',
      order: 1
    }],
    shares: [{
      id: fixtureUuid(35, 1),
      noteId: explicitNoteId,
      code: 'RestoreShare01',
      expireAt: null,
      viewCount: 7
    }],
    settings: [
      { id: 'appConfig', value: { site: { name: 'Restored NAV' } } },
      { id: 'theme', value: 'dark' },
      { id: 'whisperBgImage', value: '' }
    ],
    mediaAssets: [mediaFixture(userId, 1, 36)]
  })
}

function maximumWorkloadBackup(userId = USER_A_ID) {
  const groups = Array.from({ length: 200 }, (_, index) => ({
    id: fixtureUuid(101, index + 1),
    name: `Group ${index + 1}`,
    icon: 'folder',
    color: '#5e6ad2',
    order: index,
    collapsed: false
  }))
  const bookmarks = Array.from({ length: 2000 }, (_, index) => ({
    id: fixtureUuid(102, index + 1),
    groupId: groups[index % groups.length].id,
    title: `Bookmark ${index + 1}`,
    url: `https://example.test/bookmarks/${index + 1}`,
    favicon: '',
    description: '',
    tags: [],
    order: index
  }))
  const notes = Array.from({ length: 1000 }, (_, index) => ({
    id: fixtureUuid(103, index + 1),
    type: 'memo',
    title: `Note ${index + 1}`,
    content: `Maximum workload note ${index + 1}`,
    encrypted: false,
    password: '',
    pinned: false,
    tags: [],
    attachments: [],
    completed: false
  }))
  const customEngines = Array.from({ length: 100 }, (_, index) => ({
    id: fixtureUuid(104, index + 1),
    name: `Engine ${index + 1}`,
    icon: 'S',
    url: `https://example.test/engines/${index + 1}?q={query}`,
    order: index
  }))
  const shares = Array.from({ length: 1000 }, (_, index) => ({
    id: fixtureUuid(105, index + 1),
    noteId: notes[index].id,
    code: `MaximumShare${String(index + 1).padStart(4, '0')}`,
    expireAt: null,
    viewCount: index
  }))
  const settings = [
    { id: 'appConfig', value: { site: { name: 'Maximum restore' } } },
    { id: 'theme', value: 'dark' },
    { id: 'whisperBgImage', value: '' }
  ]
  const mediaAssets = Array.from(
    { length: 697 },
    (_, index) => mediaFixture(userId, index + 1, 106)
  )
  const backup = backupEnvelope({
    groups,
    bookmarks,
    notes,
    customEngines,
    shares,
    settings,
    mediaAssets
  })
  assert.equal(backup.manifest.counts.totalRecords, 5000)
  assert.equal(backup.manifest.counts.attachments, 0)
  return backup
}

async function dropFailureInjectionTrigger() {
  await pool.query('DROP TRIGGER IF EXISTS nav_restore_test_fail_success_audit ON security_events')
  await pool.query('DROP FUNCTION IF EXISTS nav_restore_test_fail_success_audit()')
}

async function resetDatabase() {
  await dropFailureInjectionTrigger()
  await pool.query('TRUNCATE TABLE rate_limit_buckets, users RESTART IDENTITY CASCADE')
  await pool.query("SELECT setval('notes_number_id_seq', 1000, FALSE)")
}

async function seedUser(id, username) {
  await pool.query(
    `
      INSERT INTO users (
        id, username, password_hash, role, status, approved_at
      ) VALUES ($1, $2, $3, 'user', 'approved', NOW())
    `,
    [id, username, passwordHash]
  )
}

async function seedSession(userId) {
  const id = randomUUID()
  const token = createSessionToken()
  await pool.query(
    `
      INSERT INTO sessions (
        id, user_id, token_hash, ip_address, user_agent, expires_at
      ) VALUES ($1, $2, $3, '127.0.0.1', 'restore-integration', NOW() + INTERVAL '1 day')
    `,
    [id, userId, hashSessionToken(token)]
  )
  return {
    id,
    token,
    cookie: `${config.sessionCookieName}=${token}`
  }
}

async function insertMediaAsset(userId, index, namespace) {
  const media = mediaFixture(userId, index, namespace)
  await pool.query(
    `
      INSERT INTO media_assets (
        id, user_id, upstream_id, url, name, mime, size,
        source, retention, state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      media.id,
      userId,
      media.upstreamId,
      media.url,
      media.name,
      media.mime,
      media.size,
      media.source,
      media.retention,
      media.state
    ]
  )
  return media
}

async function seedBaseline() {
  await seedUser(USER_A_ID, 'restore-user-a')
  await seedUser(USER_B_ID, 'restore-user-b')

  await pool.query(
    `
      INSERT INTO nav_groups (id, user_id, name, icon, color, display_order)
      VALUES
        ($1, $2, 'A old group', 'folder', '#5e6ad2', 1),
        ($3, $4, 'B retained group', 'folder', '#4f9d69', 1)
    `,
    [BASELINE_A_GROUP_ID, USER_A_ID, BASELINE_B_GROUP_ID, USER_B_ID]
  )
  await pool.query(
    `
      INSERT INTO nav_bookmarks (
        id, user_id, group_id, title, url, favicon, description, tags, display_order
      ) VALUES
        ($1, $2, $3, 'A old bookmark', 'https://example.test/a-old', '', '', '[]'::jsonb, 1),
        ($4, $5, $6, 'B retained bookmark', 'https://example.test/b-retained', '', '', '[]'::jsonb, 1)
    `,
    [
      fixtureUuid(21, 1), USER_A_ID, BASELINE_A_GROUP_ID,
      fixtureUuid(21, 2), USER_B_ID, BASELINE_B_GROUP_ID
    ]
  )
  await pool.query(
    `
      INSERT INTO notes (
        id, user_id, number_id, type, title, content, encrypted,
        password_hash, pinned, tags, attachments, completed
      ) VALUES
        ($1, $2, 2000, 'memo', 'A old note', 'old-a', FALSE, '', FALSE, '[]'::jsonb, '[]'::jsonb, FALSE),
        ($3, $4, 9000, 'memo', 'B retained note', 'retained-b', FALSE, '', FALSE, '[]'::jsonb, '[]'::jsonb, FALSE)
    `,
    [BASELINE_A_NOTE_ID, USER_A_ID, BASELINE_B_NOTE_ID, USER_B_ID]
  )
  await pool.query(
    `
      INSERT INTO note_shares (id, user_id, note_id, code, view_count)
      VALUES
        ($1, $2, $3, 'OldShareA01', 1),
        ($4, $5, $6, 'KeepShareB01', 2)
    `,
    [
      fixtureUuid(22, 1), USER_A_ID, BASELINE_A_NOTE_ID,
      fixtureUuid(22, 2), USER_B_ID, BASELINE_B_NOTE_ID
    ]
  )
  await pool.query(
    `
      INSERT INTO note_reminders (id, user_id, note_id, due_at_snapshot)
      VALUES
        ($1, $2, $3, NOW() + INTERVAL '1 day'),
        ($4, $5, $6, NOW() + INTERVAL '2 days')
    `,
    [
      fixtureUuid(23, 1), USER_A_ID, BASELINE_A_NOTE_ID,
      fixtureUuid(23, 2), USER_B_ID, BASELINE_B_NOTE_ID
    ]
  )
  await pool.query(
    `
      INSERT INTO custom_search_engines (
        id, user_id, name, icon, url, display_order
      ) VALUES
        ($1, $2, 'A old search', 'A', 'https://example.test/a?q={query}', 1),
        ($3, $4, 'B retained search', 'B', 'https://example.test/b?q={query}', 1)
    `,
    [fixtureUuid(24, 1), USER_A_ID, fixtureUuid(24, 2), USER_B_ID]
  )
  await pool.query(
    `
      INSERT INTO user_settings (user_id, key, value)
      VALUES
        ($1, 'appConfig', '{"site":{"name":"A old"}}'::jsonb),
        ($1, 'theme', '"light"'::jsonb),
        ($1, 'workspacePreferences', '{"density":"compact"}'::jsonb),
        ($2, 'theme', '"system"'::jsonb)
    `,
    [USER_A_ID, USER_B_ID]
  )
  await insertMediaAsset(USER_A_ID, 1, 25)
  await insertMediaAsset(USER_B_ID, 1, 26)
}

async function apiRequest(method, url, session, payload) {
  const request = {
    method,
    url: `/api${url}`,
    headers: {
      cookie: session.cookie,
      origin: TEST_ORIGIN
    }
  }
  if (payload !== undefined) request.payload = payload
  return app.inject(request)
}

async function previewRestore(session, backup, { restoreShares = true } = {}) {
  const response = await apiRequest('POST', '/migration/restore/preview', session, {
    backup,
    mode: 'replace',
    restoreShares
  })
  assert.equal(response.statusCode, 200, response.body)
  const body = json(response)
  assert.equal(body.ok, true)
  assert.deepEqual(body.preview.blockingErrors, [])
  assert.ok(body.preview.planToken)
  return body.preview
}

async function downloadSafetyBackup(session) {
  const response = await apiRequest('GET', '/migration/restore/safety-backup', session)
  assert.equal(response.statusCode, 200, response.body)
  const body = json(response)
  assert.equal(body.ok, true)
  assert.ok(body.backupReceipt)
  assert.equal(body.backup.restoreCompatibility.restorable, true)
  return body
}

function restoreApplyPayload(backup, {
  planToken,
  backupReceipt,
  currentPassword = CORRECT_PASSWORD,
  restoreShares = true
}) {
  return {
    backup,
    mode: 'replace',
    restoreShares,
    planToken,
    backupReceipt,
    currentPassword,
    confirmation: RESTORE_CONFIRMATION
  }
}

async function applyRestore(session, backup, artifacts, options = {}) {
  return apiRequest(
    'POST',
    '/migration/restore/apply',
    session,
    restoreApplyPayload(backup, {
      planToken: artifacts.planToken,
      backupReceipt: artifacts.backupReceipt,
      ...options
    })
  )
}

async function restoreArtifacts(session, backup, options = {}) {
  const preview = await previewRestore(session, backup, options)
  const safety = await downloadSafetyBackup(session)
  return {
    planToken: preview.planToken,
    backupReceipt: safety.backupReceipt
  }
}

const USER_SNAPSHOT_QUERIES = Object.freeze({
  user: 'SELECT * FROM users WHERE id = $1 ORDER BY id',
  sessions: 'SELECT * FROM sessions WHERE user_id = $1 ORDER BY id',
  groups: 'SELECT * FROM nav_groups WHERE user_id = $1 ORDER BY id',
  bookmarks: 'SELECT * FROM nav_bookmarks WHERE user_id = $1 ORDER BY id',
  notes: 'SELECT * FROM notes WHERE user_id = $1 ORDER BY id',
  shares: 'SELECT * FROM note_shares WHERE user_id = $1 ORDER BY id',
  reminders: 'SELECT * FROM note_reminders WHERE user_id = $1 ORDER BY id',
  engines: 'SELECT * FROM custom_search_engines WHERE user_id = $1 ORDER BY id',
  settings: 'SELECT * FROM user_settings WHERE user_id = $1 ORDER BY key',
  media: 'SELECT * FROM media_assets WHERE user_id = $1 ORDER BY id'
})

async function snapshotUser(userId, { includeAccount = true } = {}) {
  const entries = Object.entries(USER_SNAPSHOT_QUERIES)
    .filter(([name]) => includeAccount || !['user', 'sessions'].includes(name))
  const results = await Promise.all(
    entries.map(async ([name, sql]) => [name, (await pool.query(sql, [userId])).rows])
  )
  return Object.fromEntries(results)
}

async function sequenceState() {
  const { rows } = await pool.query(
    'SELECT last_value::text AS last_value, is_called FROM notes_number_id_seq'
  )
  return rows[0]
}

async function countUserRows(userId) {
  const { rows } = await pool.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM nav_groups WHERE user_id = $1) AS groups,
        (SELECT COUNT(*)::integer FROM nav_bookmarks WHERE user_id = $1) AS bookmarks,
        (SELECT COUNT(*)::integer FROM notes WHERE user_id = $1) AS notes,
        (SELECT COUNT(*)::integer FROM note_shares WHERE user_id = $1) AS shares,
        (SELECT COUNT(*)::integer FROM custom_search_engines WHERE user_id = $1) AS engines,
        (SELECT COUNT(*)::integer FROM user_settings WHERE user_id = $1) AS settings,
        (SELECT COUNT(*)::integer FROM media_assets WHERE user_id = $1) AS media
    `,
    [userId]
  )
  return rows[0]
}

async function monitorRestoreTableLock(done) {
  let firstObservedAt = null
  let lastObservedAt = null
  let heldSamples = 0
  const observedRelations = new Set()

  while (true) {
    const observedAt = performance.now()
    const { rows } = await pool.query(
      `
        SELECT relation.relname AS relation_name
        FROM pg_locks AS lock
        JOIN pg_class AS relation ON relation.oid = lock.relation
        WHERE lock.locktype = 'relation'
          AND lock.mode = 'ShareRowExclusiveLock'
          AND lock.granted
          AND relation.relname = ANY($1::text[])
      `,
      [RESTORE_LOCK_TABLES]
    )
    const held = rows.length > 0
    if (held) {
      heldSamples += 1
      for (const row of rows) observedRelations.add(row.relation_name)
      if (firstObservedAt === null) firstObservedAt = observedAt
      lastObservedAt = observedAt
    }
    if (done.value && !held) break
    await delay(5)
  }

  return {
    observed: firstObservedAt !== null,
    heldSamples,
    observedRelations: [...observedRelations].sort(),
    durationMs: firstObservedAt === null
      ? 0
      : Math.max(5, lastObservedAt - firstObservedAt + 5)
  }
}

before(async () => {
  const [appModule, configModule, databaseModule, authModule, mediaModule] = await Promise.all([
    import('../src/app.js'),
    import('../src/config.js'),
    import('../src/db/index.js'),
    import('../src/lib/auth.js'),
    import('../src/lib/mediaAssets.js')
  ])
  config = configModule.config
  pool = databaseModule.pool
  createMediaUserPrefix = mediaModule.createMediaUserPrefix
  createSessionToken = authModule.createSessionToken
  hashPassword = authModule.hashPassword
  hashSessionToken = authModule.hashSessionToken

  const target = await pool.query(
    `
      SELECT
        current_database() AS database_name,
        current_setting('server_version_num')::integer AS server_version_num,
        to_regclass('users') IS NOT NULL AS users_ready,
        to_regclass('security_events') IS NOT NULL AS security_events_ready,
        to_regclass('notes_number_id_seq') IS NOT NULL AS note_sequence_ready
    `
  )
  assert.equal(target.rows[0]?.database_name, EXPECTED_DATABASE_NAME)
  assert.ok(
    target.rows[0]?.server_version_num >= 160_000
      && target.rows[0]?.server_version_num < 170_000,
    'restore integration tests require PostgreSQL 16'
  )
  assert.equal(target.rows[0]?.users_ready, true, 'migrations must run before integration tests')
  assert.equal(target.rows[0]?.security_events_ready, true, 'migration 016 must be present')
  assert.equal(target.rows[0]?.note_sequence_ready, true, 'migration 008 must be present')

  assert.ok(
    String(config.rateLimitKeySecret || '').length >= 32,
    'NAV_RATE_LIMIT_KEY_SECRET must be at least 32 characters for restore integration tests'
  )
  assert.ok(
    String(config.imgBedBaseUrl || '').startsWith('https://'),
    'NAV_IMGBED_BASE_URL must be an HTTPS test origin'
  )

  passwordHash = await hashPassword(CORRECT_PASSWORD)
  app = appModule.createApp()
  await app.ready()
})

beforeEach(async () => {
  await resetDatabase()
})

after(async () => {
  if (pool) await dropFailureInjectionTrigger()
  if (app) await app.close()
  if (pool) await pool.end()
})

test('real PostgreSQL restore replaces one account, preserves the other, restores shares and advances note numbers safely', async () => {
  await seedBaseline()
  const sessionA = await seedSession(USER_A_ID)
  await seedSession(USER_B_ID)
  const userBBefore = await snapshotUser(USER_B_ID)
  const backup = normalBackup()
  const artifacts = await restoreArtifacts(sessionA, backup, { restoreShares: true })

  const response = await applyRestore(sessionA, backup, artifacts, { restoreShares: true })
  assert.equal(response.statusCode, 200, response.body)
  const body = json(response)
  assert.equal(body.ok, true)
  assert.equal(body.sharesRestored, true)
  assert.deepEqual(body.imported, {
    groups: 1,
    bookmarks: 1,
    notes: 2,
    customEngines: 1,
    shares: 1,
    settings: 3,
    mediaAssets: 1
  })

  const counts = await countUserRows(USER_A_ID)
  assert.deepEqual(counts, {
    groups: 1,
    bookmarks: 1,
    notes: 2,
    shares: 1,
    engines: 1,
    settings: 4,
    media: 2
  })
  const noteNumbers = await pool.query(
    'SELECT number_id::text AS number_id FROM notes WHERE user_id = $1 ORDER BY number_id',
    [USER_A_ID]
  )
  assert.deepEqual(noteNumbers.rows.map((row) => row.number_id), ['4000', '9001'])
  assert.equal(
    (await pool.query('SELECT COUNT(*)::integer AS count FROM note_reminders WHERE user_id = $1', [USER_A_ID])).rows[0].count,
    0
  )
  assert.deepEqual(await snapshotUser(USER_B_ID), userBBefore)

  const audit = await pool.query(
    `
      SELECT outcome, affected_count
      FROM security_events
      WHERE event_type = 'account.data.restore'
        AND actor_user_id = $1
      ORDER BY id
    `,
    [USER_A_ID]
  )
  assert.deepEqual(audit.rows, [{ outcome: 'success', affected_count: 10 }])
  assert.deepEqual(await sequenceState(), { last_value: '9001', is_called: true })
  assert.equal(
    (await pool.query("SELECT nextval('notes_number_id_seq')::text AS value")).rows[0].value,
    '9002'
  )
})

test('wrong current password cannot alter managed data or the note-number sequence', async () => {
  await seedBaseline()
  const session = await seedSession(USER_A_ID)
  const backup = normalBackup()
  const artifacts = await restoreArtifacts(session, backup)
  const beforeData = await snapshotUser(USER_A_ID, { includeAccount: false })
  const beforeSequence = await sequenceState()

  const response = await applyRestore(session, backup, artifacts, {
    currentPassword: WRONG_PASSWORD
  })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(json(response).code, 'invalid_current_password')
  assert.deepEqual(await snapshotUser(USER_A_ID, { includeAccount: false }), beforeData)
  assert.deepEqual(await sequenceState(), beforeSequence)
})

test('session-bound, tampered, expired and state-bound restore artifacts are rejected without replacement', async (t) => {
  await t.test('cross-session plan and receipt replay are rejected independently', async () => {
    await resetDatabase()
    await seedBaseline()
    const sessionOne = await seedSession(USER_A_ID)
    const sessionTwo = await seedSession(USER_A_ID)
    const backup = normalBackup()
    const planOne = await previewRestore(sessionOne, backup)
    const receiptOne = await downloadSafetyBackup(sessionOne)
    const planTwo = await previewRestore(sessionTwo, backup)
    const receiptTwo = await downloadSafetyBackup(sessionTwo)
    const beforeData = await snapshotUser(USER_A_ID, { includeAccount: false })

    const planReplay = await applyRestore(sessionTwo, backup, {
      planToken: planOne.planToken,
      backupReceipt: receiptTwo.backupReceipt
    })
    assert.equal(planReplay.statusCode, 409, planReplay.body)
    assert.equal(json(planReplay).code, 'restore_state_changed')

    const receiptReplay = await applyRestore(sessionTwo, backup, {
      planToken: planTwo.planToken,
      backupReceipt: receiptOne.backupReceipt
    })
    assert.equal(receiptReplay.statusCode, 409, receiptReplay.body)
    assert.equal(json(receiptReplay).code, 'restore_backup_receipt_changed')
    assert.deepEqual(await snapshotUser(USER_A_ID, { includeAccount: false }), beforeData)
  })

  await t.test('tampered plan and receipt are rejected independently', async () => {
    await resetDatabase()
    await seedBaseline()
    const session = await seedSession(USER_A_ID)
    const backup = normalBackup()
    const artifacts = await restoreArtifacts(session, backup)
    const beforeData = await snapshotUser(USER_A_ID, { includeAccount: false })

    const tamperedPlan = await applyRestore(session, backup, {
      planToken: flipTokenCharacter(artifacts.planToken),
      backupReceipt: artifacts.backupReceipt
    })
    assert.equal(tamperedPlan.statusCode, 409, tamperedPlan.body)
    assert.equal(json(tamperedPlan).code, 'restore_state_changed')

    const tamperedReceipt = await applyRestore(session, backup, {
      planToken: artifacts.planToken,
      backupReceipt: flipTokenCharacter(artifacts.backupReceipt)
    })
    assert.equal(tamperedReceipt.statusCode, 409, tamperedReceipt.body)
    assert.equal(json(tamperedReceipt).code, 'restore_backup_receipt_changed')
    assert.deepEqual(await snapshotUser(USER_A_ID, { includeAccount: false }), beforeData)
  })

  await t.test('expired plan and receipt return their specific failures', async (subtest) => {
    await resetDatabase()
    await seedBaseline()
    const session = await seedSession(USER_A_ID)
    const backup = normalBackup()
    subtest.mock.timers.enable({
      apis: ['Date'],
      now: new Date('2026-08-23T00:00:00.000Z')
    })
    const oldPlan = await previewRestore(session, backup)
    const oldReceipt = await downloadSafetyBackup(session)
    subtest.mock.timers.tick(RESTORE_TOKEN_TTL_MS + 60_000)
    const freshPlan = await previewRestore(session, backup)
    const freshReceipt = await downloadSafetyBackup(session)
    const beforeData = await snapshotUser(USER_A_ID, { includeAccount: false })

    const expiredPlan = await applyRestore(session, backup, {
      planToken: oldPlan.planToken,
      backupReceipt: freshReceipt.backupReceipt
    })
    assert.equal(expiredPlan.statusCode, 409, expiredPlan.body)
    assert.equal(json(expiredPlan).code, 'restore_preview_expired')

    const expiredReceipt = await applyRestore(session, backup, {
      planToken: freshPlan.planToken,
      backupReceipt: oldReceipt.backupReceipt
    })
    assert.equal(expiredReceipt.statusCode, 409, expiredReceipt.body)
    assert.equal(json(expiredReceipt).code, 'restore_backup_receipt_expired')
    assert.deepEqual(await snapshotUser(USER_A_ID, { includeAccount: false }), beforeData)
  })

  await t.test('a state change stales the plan and an older safety receipt', async () => {
    await resetDatabase()
    await seedBaseline()
    const session = await seedSession(USER_A_ID)
    const backup = normalBackup()
    const oldArtifacts = await restoreArtifacts(session, backup)
    await pool.query(
      "UPDATE nav_groups SET name = name || ' changed' WHERE id = $1",
      [BASELINE_A_GROUP_ID]
    )
    const stateAfterIntentionalChange = await snapshotUser(USER_A_ID, { includeAccount: false })

    const stalePlan = await applyRestore(session, backup, oldArtifacts)
    assert.equal(stalePlan.statusCode, 409, stalePlan.body)
    assert.equal(json(stalePlan).code, 'restore_state_changed')

    const freshPlan = await previewRestore(session, backup)
    const staleReceipt = await applyRestore(session, backup, {
      planToken: freshPlan.planToken,
      backupReceipt: oldArtifacts.backupReceipt
    })
    assert.equal(staleReceipt.statusCode, 409, staleReceipt.body)
    assert.equal(json(staleReceipt).code, 'restore_backup_receipt_changed')
    assert.deepEqual(
      await snapshotUser(USER_A_ID, { includeAccount: false }),
      stateAfterIntentionalChange
    )
  })
})

test('preview blocks all three malformed cross-account cascade relationships and issues no plan', async () => {
  await seedBaseline()
  const session = await seedSession(USER_A_ID)
  await pool.query(
    `
      INSERT INTO nav_bookmarks (
        id, user_id, group_id, title, url, favicon, description, tags, display_order
      ) VALUES ($1, $2, $3, 'Cross-account bookmark', 'https://example.test/cross', '', '', '[]'::jsonb, 2)
    `,
    [fixtureUuid(41, 1), USER_B_ID, BASELINE_A_GROUP_ID]
  )
  await pool.query(
    `
      INSERT INTO note_shares (id, user_id, note_id, code, view_count)
      VALUES ($1, $2, $3, 'CrossShare01', 0)
    `,
    [fixtureUuid(42, 1), USER_B_ID, BASELINE_A_NOTE_ID]
  )
  await pool.query(
    `
      INSERT INTO note_reminders (id, user_id, note_id, due_at_snapshot)
      VALUES ($1, $2, $3, NOW() + INTERVAL '3 days')
    `,
    [fixtureUuid(43, 1), USER_B_ID, BASELINE_A_NOTE_ID]
  )
  const beforeA = await snapshotUser(USER_A_ID)
  const beforeB = await snapshotUser(USER_B_ID)

  const response = await apiRequest('POST', '/migration/restore/preview', session, {
    backup: normalBackup(),
    mode: 'replace',
    restoreShares: true
  })
  assert.equal(response.statusCode, 200, response.body)
  const body = json(response)
  assert.equal(body.preview.planToken, '')
  assert.deepEqual(
    body.preview.blockingErrors.map((error) => error.code).sort(),
    [
      'restore-conflict-cascade-bookmarks',
      'restore-conflict-cascade-reminders',
      'restore-conflict-cascade-shares'
    ]
  )
  assert.deepEqual(await snapshotUser(USER_A_ID), beforeA)
  assert.deepEqual(await snapshotUser(USER_B_ID), beforeB)
})

test('a final success-audit failure rolls back all restored data and does not advance the non-transactional note sequence', async () => {
  await seedBaseline()
  const session = await seedSession(USER_A_ID)
  await seedSession(USER_B_ID)
  const backup = normalBackup()
  const artifacts = await restoreArtifacts(session, backup)
  const beforeA = await snapshotUser(USER_A_ID, { includeAccount: false })
  const beforeB = await snapshotUser(USER_B_ID)
  const beforeSequence = await sequenceState()

  await pool.query(`
    CREATE FUNCTION nav_restore_test_fail_success_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.event_type = 'account.data.restore' AND NEW.outcome = 'success' THEN
        RAISE EXCEPTION 'forced restore success audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `)
  await pool.query(`
    CREATE TRIGGER nav_restore_test_fail_success_audit
    BEFORE INSERT ON security_events
    FOR EACH ROW
    EXECUTE FUNCTION nav_restore_test_fail_success_audit()
  `)

  let response
  try {
    response = await applyRestore(session, backup, artifacts)
  } finally {
    await dropFailureInjectionTrigger()
  }
  assert.equal(response.statusCode, 500, response.body)
  assert.equal(json(response).error, '恢复失败，当前云端数据未更改')
  assert.deepEqual(await snapshotUser(USER_A_ID, { includeAccount: false }), beforeA)
  assert.deepEqual(await snapshotUser(USER_B_ID), beforeB)
  assert.deepEqual(await sequenceState(), beforeSequence)

  const audit = await pool.query(
    `
      SELECT outcome, COUNT(*)::integer AS count
      FROM security_events
      WHERE event_type = 'account.data.restore'
        AND actor_user_id = $1
      GROUP BY outcome
      ORDER BY outcome
    `,
    [USER_A_ID]
  )
  assert.deepEqual(audit.rows, [{ outcome: 'failure', count: 1 }])
})

test('the exact 5000-record workload is restored under an observed table lock lasting less than 60 seconds', async (t) => {
  await seedBaseline()
  const session = await seedSession(USER_A_ID)
  await seedSession(USER_B_ID)
  const userBBefore = await snapshotUser(USER_B_ID)
  const backup = maximumWorkloadBackup()
  const artifacts = await restoreArtifacts(session, backup, { restoreShares: true })
  const payload = restoreApplyPayload(backup, {
    ...artifacts,
    restoreShares: true
  })
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  assert.ok(payloadBytes < RESTORE_BODY_LIMIT)

  const done = { value: false }
  const lockMonitor = monitorRestoreTableLock(done)
  const startedAt = performance.now()
  let response
  try {
    response = await apiRequest(
      'POST',
      '/migration/restore/apply',
      session,
      payload
    )
  } finally {
    done.value = true
  }
  const requestDurationMs = performance.now() - startedAt
  const lock = await lockMonitor

  assert.equal(response.statusCode, 200, response.body)
  assert.equal(json(response).ok, true)
  assert.equal(json(response).imported.groups, 200)
  assert.equal(json(response).imported.bookmarks, 2000)
  assert.equal(json(response).imported.notes, 1000)
  assert.equal(json(response).imported.customEngines, 100)
  assert.equal(json(response).imported.shares, 1000)
  assert.equal(json(response).imported.settings, 3)
  assert.equal(json(response).imported.mediaAssets, 697)
  assert.equal(lock.observed, true, 'the real restore table lock must be observed')
  assert.deepEqual(
    lock.observedRelations,
    [...RESTORE_LOCK_TABLES].sort(),
    'all eight restore target tables must hold ShareRowExclusiveLock'
  )
  assert.ok(
    lock.durationMs < 60_000,
    `maximum restore lock lasted ${Math.round(lock.durationMs)} ms`
  )
  assert.deepEqual(await countUserRows(USER_A_ID), {
    groups: 200,
    bookmarks: 2000,
    notes: 1000,
    shares: 1000,
    engines: 100,
    settings: 4,
    media: 698
  })
  assert.deepEqual(await snapshotUser(USER_B_ID), userBBefore)
  assert.deepEqual(await sequenceState(), { last_value: '10000', is_called: true })
  assert.equal(
    (await pool.query("SELECT nextval('notes_number_id_seq')::text AS value")).rows[0].value,
    '10001'
  )
  t.diagnostic(JSON.stringify({
    records: backup.manifest.counts.totalRecords,
    payloadBytes,
    requestDurationMs: Math.round(requestDurationMs),
    observedLockDurationMs: Math.round(lock.durationMs),
    heldLockSamples: lock.heldSamples,
    observedLockRelations: lock.observedRelations
  }))
})
