import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildBackendExport,
  sanitizeSettingForBackendExport
} from '../src/routes/migration.js'
import {
  DATA_RESTORE_SOURCES,
  validateDataRestoreRequest
} from '../src/lib/dataRestore.js'

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BOOKMARK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MEMO_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DIARY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SHARE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const ENGINE_ID = '99999999-9999-4999-8999-999999999999'
const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111'
const MEDIA_ASSET_ID = '22222222-2222-4222-8222-222222222222'

function createFixtureClient() {
  const queries = []
  const rows = {
    groups: [{
      id: GROUP_ID,
      name: '工作',
      icon: 'briefcase',
      color: '#8f7358',
      display_order: 2,
      collapsed: false,
      created_at: '2026-07-30T01:02:03.000Z',
      updated_at: '2026-07-31T04:05:06.000Z'
    }],
    bookmarks: [{
      id: BOOKMARK_ID,
      group_id: GROUP_ID,
      title: 'Domo NAV',
      url: 'https://nav.skrskr.net/',
      favicon: 'https://nav.skrskr.net/icon.png',
      description: '个人导航',
      tags: ['常用', '导航'],
      display_order: 1,
      created_at: '2026-07-30T01:02:03.000Z',
      updated_at: '2026-07-31T04:05:06.000Z'
    }],
    notes: [
      {
        id: MEMO_ID,
        number_id: '1000',
        type: 'memo',
        title: '图床说明',
        content: '图片保存在图床。',
        content_format: 'tiptap-json',
        content_json: {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: '图床说明' }]
            },
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '图片保存在图床。' }]
            },
            {
              type: 'image',
              attrs: {
                src: 'https://pic.skrskr.net/file/nav-notes/example.webp',
                alt: '示例图片',
                title: 'example.webp'
              }
            }
          ]
        },
        content_json_encrypted: null,
        encrypted: false,
        password_hash: '',
        pinned: true,
        tags: ['图片', '运维'],
        attachments: [{
          id: ATTACHMENT_ID,
          url: 'https://pic.skrskr.net/file/nav-notes/example.webp',
          name: 'example.webp',
          mime: 'image/webp',
          size: 2048,
          createdAt: '2026-07-31T06:00:00.000Z'
        }],
        entry_date: null,
        mood: '',
        due_at: '2026-08-01T12:00:00.000Z',
        remind_before_minutes: 30,
        completed: false,
        revision: 4,
        created_at: '2026-07-31T05:00:00.000Z',
        updated_at: '2026-07-31T06:00:00.000Z'
      },
      {
        id: DIARY_ID,
        number_id: '1001',
        type: 'diary',
        title: '加密日记',
        content: '{"iv":"cipher-iv","ciphertext":"cipher-body"}',
        content_format: 'tiptap-json',
        content_json: null,
        content_json_encrypted: 'encrypted-tiptap-document',
        encrypted: true,
        password_hash: 'pbkdf2$sha256$verifier',
        pinned: false,
        tags: ['私人'],
        attachments: [],
        entry_date: '2026-07-31',
        mood: '平静',
        due_at: null,
        completed: false,
        remind_before_minutes: 0,
        revision: 2,
        created_at: '2026-07-31T07:00:00.000Z',
        updated_at: '2026-07-31T08:00:00.000Z'
      }
    ],
    shares: [{
      id: SHARE_ID,
      note_id: MEMO_ID,
      code: 'Share001',
      expire_at: '2026-08-31T00:00:00.000Z',
      view_count: '3',
      created_at: '2026-07-31T06:30:00.000Z'
    }],
    engines: [{
      id: ENGINE_ID,
      name: '官方文档',
      icon: '官',
      url: 'https://example.com/search?q={query}',
      display_order: 4,
      created_at: '2026-07-30T01:02:03.000Z',
      updated_at: '2026-07-31T04:05:06.000Z'
    }],
    settings: [
      {
        key: 'appConfig',
        value: {
          theme: 'warm-dark',
          search: {
            providers: {
              chatgpt: {
                endpoint: 'https://ap.skrskr.net/v1/chat/completions',
                apiKey: 'sk-cli-proxy-secret'
              },
              brave: {
                endpoint: 'https://api.search.brave.com',
                apiKey: 'brave-secret'
              }
            }
          },
          integrations: {
            clientSecret: 'oauth-client-secret',
            label: '保留普通配置'
          }
        }
      },
      {
        key: 'theme',
        value: 'dark'
      },
      {
        key: 'workspacePreferences',
        value: {
          accent: 'brown',
          privateKey: 'private-key-secret'
        }
      },
      {
        key: 'telegramConfig',
        value: {
          botToken: 'telegram-bot-token',
          chatId: '123456'
        }
      },
      {
        key: 'telegramUpdateOffset',
        value: 12345
      },
      {
        key: 'apiToken',
        value: 'top-level-api-token'
      }
    ],
    mediaAssets: [{
      id: MEDIA_ASSET_ID,
      upstream_id: 'nav-notes/example.webp',
      url: 'https://pic.skrskr.net/file/nav-notes/example.webp',
      name: 'example.webp',
      mime: 'image/webp',
      size: '2048',
      source: 'note',
      retention: 'auto',
      state: 'active',
      delete_attempts: 0,
      created_at: '2026-07-31T06:00:00.000Z',
      updated_at: '2026-07-31T06:00:00.000Z',
      deleted_at: null
    }]
  }

  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params })

      if (/FROM nav_groups/.test(sql)) return { rows: rows.groups }
      if (/FROM nav_bookmarks/.test(sql)) return { rows: rows.bookmarks }
      if (/FROM note_shares/.test(sql)) return { rows: rows.shares }
      if (/FROM notes/.test(sql)) return { rows: rows.notes }
      if (/FROM custom_search_engines/.test(sql)) return { rows: rows.engines }
      if (/FROM user_settings/.test(sql)) return { rows: rows.settings }
      if (/FROM media_assets/.test(sql)) return { rows: rows.mediaAssets }

      throw new Error(`Unexpected query: ${sql}`)
    }
  }
}

test('backend export is import-compatible and preserves cloud data metadata', async () => {
  const client = createFixtureClient()
  const exportedAt = '2026-07-31T09:08:07.000Z'
  const backup = await buildBackendExport(client, USER_ID, { exportedAt })

  assert.equal(backup.schema, 'domo-nav-backup')
  assert.equal(backup.version, 1)
  assert.equal(backup.exportedAt, exportedAt)
  assert.equal(
    backup.fileName,
    'domo-nav-cloud-backup-20260731-090807Z.json'
  )

  const importKeys = [
    'groups',
    'bookmarks',
    'notes',
    'customEngines',
    'mediaAssets',
    'shares',
    'settings'
  ]
  assert.deepEqual(Object.keys(backup.data).sort(), importKeys.sort())
  for (const key of importKeys) {
    assert.ok(Array.isArray(backup.data[key]), `${key} must be an array`)
  }

  assert.equal(backup.data.bookmarks[0].groupId, GROUP_ID)
  assert.deepEqual(backup.data.bookmarks[0].tags, ['常用', '导航'])
  assert.equal(backup.data.shares[0].noteId, MEMO_ID)

  const memo = backup.data.notes.find((note) => note.id === MEMO_ID)
  assert.equal(memo.numberId, 1000)
  assert.deepEqual(memo.tags, ['图片', '运维'])
  assert.equal(memo.dueAt, '2026-08-01T12:00:00.000Z')
  assert.equal(memo.contentFormat, 'tiptap-json')
  assert.equal(memo.contentJson.type, 'doc')
  assert.equal(memo.contentJson.content[2].attrs.src, memo.attachments[0].url)
  assert.equal(memo.contentJsonEncrypted, null)
  assert.equal(memo.remindBeforeMinutes, 30)
  assert.equal(memo.revision, 4)
  assert.deepEqual(memo.attachments, [{
    id: ATTACHMENT_ID,
    url: 'https://pic.skrskr.net/file/nav-notes/example.webp',
    name: 'example.webp',
    mime: 'image/webp',
    size: 2048,
    createdAt: '2026-07-31T06:00:00.000Z'
  }])

  const diary = backup.data.notes.find((note) => note.id === DIARY_ID)
  assert.equal(diary.encrypted, true)
  assert.equal(
    diary.content,
    '{"iv":"cipher-iv","ciphertext":"cipher-body"}'
  )
  assert.equal(diary.password, '')
  assert.equal(diary.numberId, 1001)
  assert.equal(diary.entryDate, '2026-07-31')
  assert.equal(diary.contentFormat, 'tiptap-json')
  assert.equal(diary.contentJson, null)
  assert.equal(diary.contentJsonEncrypted, 'encrypted-tiptap-document')
  assert.equal(diary.revision, 2)

  assert.deepEqual(backup.manifest.counts, {
    groups: 1,
    bookmarks: 1,
    notes: 2,
    customEngines: 1,
    shares: 1,
    settings: 2,
    mediaAssets: 1,
    attachments: 1,
    totalRecords: 9
  })
  assert.deepEqual(backup.manifest.attachments, {
    count: 1,
    binaryIncluded: false,
    content: 'external-url-metadata'
  })
  assert.deepEqual(backup.manifest.mediaLibrary, {
    count: 1,
    binaryIncluded: false,
    content: 'external-object-catalog-metadata',
    credentialsIncluded: false
  })
  assert.deepEqual(backup.data.mediaAssets, [{
    id: MEDIA_ASSET_ID,
    upstreamId: 'nav-notes/example.webp',
    url: 'https://pic.skrskr.net/file/nav-notes/example.webp',
    name: 'example.webp',
    mime: 'image/webp',
    size: 2048,
    source: 'note',
    retention: 'auto',
    state: 'active',
    deleteAttempts: 0,
    createdAt: '2026-07-31T06:00:00.000Z',
    updatedAt: '2026-07-31T06:00:00.000Z',
    deletedAt: null
  }])
  assert.deepEqual(backup.manifest.security.encryptedNotes, {
    count: 1,
    ciphertextIncluded: true,
    passwordVerifierIncluded: false
  })
  assert.deepEqual(backup.manifest.security.publicShareCodes, {
    count: 1,
    included: true,
    warning: 'Share codes are bearer links; protect this backup as sensitive data.'
  })

  // The exported cloud envelope is accepted unchanged by the guarded restore parser.
  const restore = validateDataRestoreRequest({
    ...backup,
    source: DATA_RESTORE_SOURCES.CLOUD_BACKUP,
    restoreShares: false
  })
  assert.deepEqual(Object.keys(restore.data).sort(), importKeys.sort())
  assert.equal(restore.counts.notes, 2)
  assert.equal(restore.counts.shares, 0)
  assert.equal(restore.backupCounts.shares, 1)
})

test('backend export isolates users and never serializes API or Telegram secrets', async () => {
  const client = createFixtureClient()
  const backup = await buildBackendExport(client, USER_ID, {
    exportedAt: '2026-07-31T09:08:07.000Z'
  })

  assert.equal(client.queries.length, 7)
  for (const query of client.queries) {
    assert.deepEqual(query.params, [USER_ID])
    assert.match(query.sql, /\$1/)
  }

  assert.match(
    client.queries.find(({ sql }) => /FROM note_shares/.test(sql)).sql,
    /JOIN notes n[\s\S]*n\.user_id = \$1[\s\S]*s\.user_id = \$1/
  )
  for (const table of [
    'nav_groups',
    'nav_bookmarks',
    'notes',
    'media_assets',
    'custom_search_engines',
    'user_settings'
  ]) {
    const query = client.queries.find(({ sql }) => (
      new RegExp(`FROM ${table}\\b`).test(sql)
    ))
    assert.match(query.sql, /WHERE user_id = \$1/)
  }

  const serialized = JSON.stringify(backup)
  for (const secret of [
    'sk-cli-proxy-secret',
    'brave-secret',
    'oauth-client-secret',
    'private-key-secret',
    'telegram-bot-token',
    'top-level-api-token'
  ]) {
    assert.equal(serialized.includes(secret), false)
  }

  assert.equal(backup.manifest.security.credentialSecretsIncluded, false)
  assert.deepEqual(
    backup.manifest.security.excludedSettings.map(({ key }) => key).sort(),
    [
      'apiToken',
      'telegramConfig',
      'telegramUpdateOffset',
      'workspacePreferences'
    ].sort()
  )

  const appConfig = backup.data.settings.find(({ id }) => id === 'appConfig')
  assert.equal(
    Object.hasOwn(appConfig.value.search.providers.chatgpt, 'apiKey'),
    false
  )
  assert.equal(
    Object.hasOwn(appConfig.value.search.providers.chatgpt, 'apiKeyConfigured'),
    false
  )
  assert.equal(
    Object.hasOwn(appConfig.value.search.providers.brave, 'apiKey'),
    false
  )
  assert.equal(
    Object.hasOwn(appConfig.value, 'integrations'),
    false
  )

  assert.equal(
    backup.data.settings.some(({ id }) => id === 'workspacePreferences'),
    false
  )
  assert.ok(
    backup.manifest.security.redactedPaths.some(
      (path) => path.endsWith('.integrations')
    )
  )
})

test('backend export route is authenticated, non-cacheable and downloadable', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.match(
    source,
    /fastify\.get\('\/migration\/export-cloud'[\s\S]*requireAuth/
  )
  assert.match(source, /Cache-Control', 'no-store, max-age=0'/)
  assert.match(source, /Surrogate-Control', 'no-store'/)
  assert.match(source, /Content-Disposition'[\s\S]*attachment; filename=/)
})

test('individual setting sanitizer excludes unknown settings and keeps allowlisted data', () => {
  assert.deepEqual(
    sanitizeSettingForBackendExport({
      key: 'telegramConfig',
      value: { botToken: 'must-not-export' }
    }).excluded,
    {
      key: 'telegramConfig',
      reason: 'operational-or-secret-setting'
    }
  )

  const unknown = sanitizeSettingForBackendExport({
    key: 'preferences',
    value: {
      density: 'compact',
      accessToken: 'must-not-export'
    }
  })
  assert.deepEqual(unknown.excluded, {
    key: 'preferences',
    reason: 'setting-key-not-allowlisted'
  })

  const theme = sanitizeSettingForBackendExport({
    key: 'theme',
    value: 'dark'
  })
  assert.deepEqual(theme.setting, { id: 'theme', value: 'dark' })
})
