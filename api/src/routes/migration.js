import { config } from '../config.js'
import { withTransaction } from '../db/index.js'
import {
  assertAttachmentsAllowedForEncryption,
  getImgBedOrigin,
  normalizeNoteAttachments
} from '../lib/noteAttachments.js'
import {
  isValidSearchUrl,
  normalizeEngineMonogram
} from '../lib/searchEngines.js'
import {
  sanitizeRetiredSearchProviders
} from '../lib/settingsSecrets.js'

const MIN_NOTE_NUMBER_ID = 1000
const MAX_IMPORTED_NOTE_NUMBER_ID = 999999999
const BACKUP_SCHEMA = 'domo-nav-backup'
const BACKUP_VERSION = 1
const EXCLUDED_SETTING_KEYS = new Set([
  'telegramConfig',
  'telegramUpdateOffset'
])
const EXPORTABLE_SETTING_KEYS = new Set([
  'appConfig',
  'theme',
  'whisperBgImage'
])
const SENSITIVE_SETTING_NAME_PATTERN = /(api.?key|access.?key|token|secret|password|passwd|credential|cookie|authorization|private.?key|client.?secret)/i
const APP_CONFIG_EXPORT_SCHEMA = Object.freeze({
  site: {
    name: true,
    icon: true,
    favicon: true
  },
  searchEngine: true,
  search: {
    aggregate: {
      enabled: true,
      engines: true
    },
    quickAccessEngineIds: true,
    hiddenEngineIds: true,
    providers: {
      chatgpt: {
        enabled: true,
        mode: true,
        apiMode: true,
        endpoint: true,
        modelMode: true,
        model: true,
        cliProxyBaseUrl: true,
        webSearchEnabled: true,
        reasoningEffort: true
      },
      brave: {
        enabled: true,
        endpoint: true
      }
    }
  },
  modules: {
    navigation: true,
    whisper: true,
    settings: true
  },
  style: {
    colorScheme: true,
    accentColor: true,
    borderRadius: true,
    cardSize: true,
    animationsEnabled: true,
    backgroundImage: true,
    customTheme: {
      primary: true,
      bg: true,
      bgSecondary: true,
      bgCard: true,
      textPrimary: true,
      textSecondary: true,
      darkBg: true,
      darkBgSecondary: true,
      darkBgCard: true,
      darkTextPrimary: true,
      darkTextSecondary: true
    }
  },
  layout: {
    columns: true,
    showDescription: true,
    showFavicon: true
  }
})

function toTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}

function toJsonArray(value) {
  const normalized = Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  return JSON.stringify(normalized)
}

function toDateOnly(value) {
  const input = String(value || '').trim()
  if (!input) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null

  const date = new Date(`${input}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === input
    ? input
    : null
}

function normalizeNoteNumberId(value) {
  if (value === null || value === undefined || value === '') return null
  const numberId = Number(value)
  return Number.isSafeInteger(numberId)
    && numberId >= MIN_NOTE_NUMBER_ID
    && numberId <= MAX_IMPORTED_NOTE_NUMBER_ID
    ? numberId
    : null
}

function createHttpError(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function cloneJson(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function isSensitiveSettingName(value) {
  const name = String(value || '').replace(/[^a-z0-9]/gi, '')
  if (!name || /(configured|redacted)$/i.test(name)) return false
  return SENSITIVE_SETTING_NAME_PATTERN.test(name)
}

function projectAllowedSettingFields(value, schema, path, excludedPaths) {
  if (schema === true) {
    return cloneJson(value)
  }

  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !schema
    || typeof schema !== 'object'
  ) {
    return undefined
  }

  const projected = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      excludedPaths.push(nestedPath)
      continue
    }

    const projectedValue = projectAllowedSettingFields(
      nestedValue,
      schema[key],
      nestedPath,
      excludedPaths
    )
    if (projectedValue !== undefined) {
      projected[key] = projectedValue
    }
  }

  return projected
}

export function sanitizeSettingForBackendExport(record = {}) {
  const key = String(record.key || '').trim()
  if (!key) {
    return {
      excluded: {
        key: '(empty)',
        reason: 'invalid-setting-key'
      },
      redactedPaths: []
    }
  }

  if (EXCLUDED_SETTING_KEYS.has(key)) {
    return {
      excluded: {
        key,
        reason: 'operational-or-secret-setting'
      },
      redactedPaths: []
    }
  }

  if (isSensitiveSettingName(key) || !EXPORTABLE_SETTING_KEYS.has(key)) {
    return {
      excluded: {
        key,
        reason: isSensitiveSettingName(key)
          ? 'sensitive-setting-key'
          : 'setting-key-not-allowlisted'
      },
      redactedPaths: []
    }
  }

  const redactedPaths = []
  const value = key === 'appConfig'
    ? projectAllowedSettingFields(
        sanitizeRetiredSearchProviders(record.value),
        APP_CONFIG_EXPORT_SCHEMA,
        `data.settings.${key}.value`,
        redactedPaths
      )
    : cloneJson(record.value)

  return {
    setting: {
      id: key,
      value
    },
    redactedPaths
  }
}

function mapBackendExportGroup(record) {
  return {
    id: record.id,
    name: record.name,
    icon: record.icon,
    color: record.color,
    order: record.display_order,
    collapsed: Boolean(record.collapsed),
    createdAt: toTimestamp(record.created_at),
    updatedAt: toTimestamp(record.updated_at)
  }
}

function mapBackendExportBookmark(record) {
  return {
    id: record.id,
    groupId: record.group_id,
    title: record.title,
    url: record.url,
    favicon: record.favicon || '',
    description: record.description || '',
    tags: Array.isArray(record.tags) ? cloneJson(record.tags) : [],
    order: record.display_order,
    createdAt: toTimestamp(record.created_at),
    updatedAt: toTimestamp(record.updated_at)
  }
}

function mapBackendExportNote(record) {
  return {
    id: record.id,
    numberId: normalizeNoteNumberId(record.number_id),
    type: record.type === 'diary' ? 'diary' : 'memo',
    title: record.title,
    content: record.content || '',
    encrypted: Boolean(record.encrypted),
    password: '',
    pinned: Boolean(record.pinned),
    tags: Array.isArray(record.tags) ? cloneJson(record.tags) : [],
    attachments: normalizeNoteAttachments(record.attachments, {
      maxBytes: Number.MAX_SAFE_INTEGER
    }),
    entryDate: record.type === 'diary' ? toDateOnly(record.entry_date) : null,
    mood: record.type === 'diary' ? String(record.mood || '') : '',
    dueAt: record.type === 'memo' ? toTimestamp(record.due_at) : null,
    completed: record.type === 'memo' && Boolean(record.completed),
    createdAt: toTimestamp(record.created_at),
    updatedAt: toTimestamp(record.updated_at)
  }
}

function mapBackendExportShare(record) {
  return {
    id: record.id,
    noteId: record.note_id,
    code: record.code,
    expireAt: toTimestamp(record.expire_at),
    viewCount: Number(record.view_count || 0),
    createdAt: toTimestamp(record.created_at)
  }
}

function mapBackendExportEngine(record) {
  return {
    id: record.id,
    name: record.name,
    icon: normalizeEngineMonogram(record.icon),
    url: record.url,
    order: record.display_order,
    createdAt: toTimestamp(record.created_at),
    updatedAt: toTimestamp(record.updated_at)
  }
}

function createBackendExportFileName(exportedAt) {
  const timestamp = exportedAt
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('T', '-')
  return `domo-nav-cloud-backup-${timestamp}.json`
}

export async function buildBackendExport(client, userId, {
  exportedAt = new Date().toISOString()
} = {}) {
  const params = [userId]
  const groupsResult = await client.query(
    `
      SELECT *
      FROM nav_groups
      WHERE user_id = $1
      ORDER BY display_order ASC, created_at ASC
    `,
    params
  )
  const bookmarksResult = await client.query(
    `
      SELECT *
      FROM nav_bookmarks
      WHERE user_id = $1
      ORDER BY group_id ASC, display_order ASC, created_at ASC
    `,
    params
  )
  const notesResult = await client.query(
    `
      SELECT *
      FROM notes
      WHERE user_id = $1
      ORDER BY updated_at DESC, created_at DESC
    `,
    params
  )
  const sharesResult = await client.query(
    `
      SELECT s.*
      FROM note_shares s
      JOIN notes n
        ON n.id = s.note_id
       AND n.user_id = $1
      WHERE s.user_id = $1
      ORDER BY s.created_at ASC
    `,
    params
  )
  const enginesResult = await client.query(
    `
      SELECT *
      FROM custom_search_engines
      WHERE user_id = $1
      ORDER BY display_order ASC, created_at ASC
    `,
    params
  )
  const settingsResult = await client.query(
    `
      SELECT key, value
      FROM user_settings
      WHERE user_id = $1
      ORDER BY key ASC
    `,
    params
  )

  const groups = groupsResult.rows.map(mapBackendExportGroup)
  const bookmarks = bookmarksResult.rows.map(mapBackendExportBookmark)
  const notes = notesResult.rows.map(mapBackendExportNote)
  const shares = sharesResult.rows.map(mapBackendExportShare)
  const customEngines = enginesResult.rows.map(mapBackendExportEngine)
  const settings = []
  const excludedSettings = []
  const redactedPaths = []

  for (const record of settingsResult.rows) {
    const sanitized = sanitizeSettingForBackendExport(record)
    if (sanitized.setting) settings.push(sanitized.setting)
    if (sanitized.excluded) excludedSettings.push(sanitized.excluded)
    redactedPaths.push(...sanitized.redactedPaths)
  }

  const counts = {
    groups: groups.length,
    bookmarks: bookmarks.length,
    notes: notes.length,
    customEngines: customEngines.length,
    shares: shares.length,
    settings: settings.length,
    attachments: notes.reduce(
      (total, note) => total + note.attachments.length,
      0
    )
  }

  return {
    schema: BACKUP_SCHEMA,
    version: BACKUP_VERSION,
    exportedAt,
    fileName: createBackendExportFileName(exportedAt),
    manifest: {
      schema: BACKUP_SCHEMA,
      version: BACKUP_VERSION,
      source: 'postgresql',
      scope: 'authenticated-user',
      counts: {
        ...counts,
        totalRecords: (
          counts.groups
          + counts.bookmarks
          + counts.notes
          + counts.customEngines
          + counts.shares
          + counts.settings
        )
      },
      attachments: {
        count: counts.attachments,
        binaryIncluded: false,
        content: 'external-url-metadata'
      },
      security: {
        credentialSecretsIncluded: false,
        policy: 'allowlisted-and-excluded',
        redactedPaths: [...new Set(redactedPaths)].sort(),
        excludedSettings,
        encryptedNotes: {
          count: notes.filter((note) => note.encrypted).length,
          ciphertextIncluded: true,
          passwordVerifierIncluded: false
        },
        publicShareCodes: {
          count: shares.length,
          included: true,
          warning: 'Share codes are bearer links; protect this backup as sensitive data.'
        }
      }
    },
    data: {
      groups,
      bookmarks,
      notes,
      customEngines,
      shares,
      settings
    }
  }
}

export default async function migrationRoutes(fastify) {
  fastify.get('/migration/export-cloud', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const backup = await withTransaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      )
      return buildBackendExport(client, request.currentUser.id)
    })

    reply.header('Cache-Control', 'no-store, max-age=0')
    reply.header('Pragma', 'no-cache')
    reply.header('Surrogate-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header(
      'Content-Disposition',
      `attachment; filename="${backup.fileName}"`
    )

    return backup
  })

  fastify.post('/migration/import-local', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const data = request.body?.data || {}
    const groups = Array.isArray(data.groups) ? data.groups : []
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : []
    const notes = Array.isArray(data.notes) ? data.notes : []
    const customEngines = Array.isArray(data.customEngines) ? data.customEngines : []
    const shares = Array.isArray(data.shares) ? data.shares : []
    const settings = Array.isArray(data.settings) ? data.settings : []
    const importedGroupIds = new Set(
      groups.map((group) => String(group?.id || ''))
    )
    const importedNotesById = new Map(
      notes.map((note) => [String(note?.id || ''), note])
    )
    const invalidEngine = customEngines.find((engine) => !isValidSearchUrl(engine?.url))
    const invalidBookmark = bookmarks.find((bookmark) => !isValidSearchUrl(bookmark?.url))
    const invalidBookmarkGroup = bookmarks.find((bookmark) => (
      !importedGroupIds.has(String(bookmark?.groupId || ''))
    ))
    const invalidShare = shares.find((share) => (
      !importedNotesById.has(String(share?.noteId || ''))
    ))
    const encryptedShare = shares.find((share) => (
      Boolean(importedNotesById.get(String(share?.noteId || ''))?.encrypted)
    ))

    if (invalidEngine) {
      reply.code(400)
      return {
        error: `自定义搜索引擎「${String(invalidEngine.name || '未命名')}」的 URL 无效`
      }
    }

    if (invalidBookmark) {
      reply.code(400)
      return {
        error: `导航「${String(invalidBookmark.title || '未命名')}」的 URL 无效`
      }
    }

    if (invalidBookmarkGroup) {
      reply.code(400)
      return { error: '导航记录必须引用本次导入的分组' }
    }

    if (invalidShare) {
      reply.code(400)
      return { error: '分享记录必须引用本次导入的笔记' }
    }

    if (encryptedShare) {
      reply.code(400)
      return { error: '加密笔记不能包含公开分享记录' }
    }

    const importedNumberIds = notes
      .map((note) => normalizeNoteNumberId(note?.numberId))
      .filter((numberId) => numberId !== null)
    const invalidNumberId = notes.find((note) => (
      note?.numberId !== null
      && note?.numberId !== undefined
      && note?.numberId !== ''
      && normalizeNoteNumberId(note.numberId) === null
    ))

    if (invalidNumberId) {
      reply.code(400)
      return {
        error: `导入的笔记数字 ID 必须是 ${MIN_NOTE_NUMBER_ID} 到 ${MAX_IMPORTED_NOTE_NUMBER_ID} 之间的整数`
      }
    }

    if (new Set(importedNumberIds).size !== importedNumberIds.length) {
      reply.code(400)
      return { error: '导入数据包含重复的笔记数字 ID' }
    }

    const importedAttachmentsByNoteId = new Map()
    for (const note of notes) {
      const attachments = normalizeNoteAttachments(note?.attachments, {
        allowedOrigin: getImgBedOrigin(config.imgBedBaseUrl),
        maxBytes: config.imgBedMaxImageBytes,
        strict: true
      })
      assertAttachmentsAllowedForEncryption(Boolean(note?.encrypted), attachments)
      importedAttachmentsByNoteId.set(String(note?.id || ''), attachments)
    }

    await withTransaction(async (client) => {
      await client.query('LOCK TABLE notes IN SHARE ROW EXCLUSIVE MODE')

      if (importedNumberIds.length) {
        const conflicts = await client.query(
          `
            SELECT number_id
            FROM notes
            WHERE number_id = ANY($1::bigint[])
              AND user_id <> $2
            LIMIT 1
          `,
          [importedNumberIds, request.currentUser.id]
        )

        if (conflicts.rows.length) {
          throw createHttpError(
            `笔记数字 ID #${conflicts.rows[0].number_id} 已被占用，未执行导入`,
            409
          )
        }

        await client.query(
          `
            SELECT setval(
              'notes_number_id_seq',
              GREATEST(
                (SELECT last_value FROM notes_number_id_seq),
                $1::bigint
              ),
              TRUE
            )
          `,
          [importedNumberIds.reduce(
            (largest, numberId) => Math.max(largest, numberId),
            MIN_NOTE_NUMBER_ID
          )]
        )
      }

      await client.query('DELETE FROM nav_bookmarks WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM nav_groups WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM note_shares WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM notes WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM custom_search_engines WHERE user_id = $1', [request.currentUser.id])
      await client.query(
        `
          DELETE FROM user_settings
          WHERE user_id = $1
            AND key NOT IN ('telegramConfig', 'telegramUpdateOffset')
        `,
        [request.currentUser.id]
      )

      for (const group of groups) {
        await client.query(
          `
            INSERT INTO nav_groups (
              id,
              user_id,
              name,
              icon,
              color,
              display_order,
              collapsed,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), COALESCE($9, NOW()))
          `,
          [
            group.id,
            request.currentUser.id,
            String(group.name || 'Untitled'),
            String(group.icon || 'folder'),
            String(group.color || '#3b82f6'),
            Number(group.order || 0),
            Boolean(group.collapsed),
            toTimestamp(group.createdAt),
            toTimestamp(group.updatedAt)
          ]
        )
      }

      for (const bookmark of bookmarks) {
        const result = await client.query(
          `
            INSERT INTO nav_bookmarks (
              id,
              user_id,
              group_id,
              title,
              url,
              favicon,
              description,
              tags,
              display_order,
              created_at,
              updated_at
            )
            SELECT
              $1,
              $2,
              g.id,
              $4,
              $5,
              $6,
              $7,
              $8::jsonb,
              $9,
              COALESCE($10, NOW()),
              COALESCE($11, NOW())
            FROM nav_groups g
            WHERE g.id = $3
              AND g.user_id = $2
            RETURNING id
          `,
          [
            bookmark.id,
            request.currentUser.id,
            bookmark.groupId,
            String(bookmark.title || 'Untitled'),
            String(bookmark.url || '').trim(),
            String(bookmark.favicon || ''),
            String(bookmark.description || ''),
            toJsonArray(bookmark.tags),
            Number(bookmark.order || 0),
            toTimestamp(bookmark.createdAt),
            toTimestamp(bookmark.updatedAt)
          ]
        )

        if (!result.rows.length) {
          throw createHttpError('导航记录引用的分组不可用，未执行导入', 400)
        }
      }

      for (const note of notes) {
        await client.query(
          `
            INSERT INTO notes (
              id,
              user_id,
              number_id,
              type,
              title,
              content,
              encrypted,
              password_hash,
              pinned,
              tags,
              attachments,
              entry_date,
              mood,
              due_at,
              completed,
              created_at,
              updated_at
            ) VALUES (
              $1,
              $2,
              COALESCE($3::bigint, nextval('notes_number_id_seq')),
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10::jsonb,
              $11::jsonb,
              $12,
              $13,
              $14,
              $15,
              COALESCE($16, NOW()),
              COALESCE($17, NOW())
            )
          `,
          [
            note.id,
            request.currentUser.id,
            normalizeNoteNumberId(note.numberId),
            note.type === 'diary' ? 'diary' : 'memo',
            String(note.title || 'Untitled'),
            String(note.content || ''),
            Boolean(note.encrypted),
            String(note.password || ''),
            Boolean(note.pinned),
            toJsonArray(note.tags),
            JSON.stringify(importedAttachmentsByNoteId.get(String(note.id || '')) || []),
            note.type === 'diary' ? toDateOnly(note.entryDate) : null,
            note.type === 'diary' ? String(note.mood || '').slice(0, 40) : '',
            note.type === 'memo' ? toTimestamp(note.dueAt) : null,
            note.type === 'memo' && Boolean(note.completed),
            toTimestamp(note.createdAt),
            toTimestamp(note.updatedAt)
          ]
        )
      }

      await client.query(
        `
          SELECT setval(
            'notes_number_id_seq',
            GREATEST(
              (SELECT last_value FROM notes_number_id_seq),
              COALESCE((SELECT MAX(number_id) FROM notes), 1000)
            ),
            TRUE
          )
        `
      )

      for (const share of shares) {
        const result = await client.query(
          `
            INSERT INTO note_shares (
              id,
              user_id,
              note_id,
              code,
              expire_at,
              view_count,
              created_at
            )
            SELECT
              $1,
              $2,
              n.id,
              $4,
              $5,
              $6,
              COALESCE($7, NOW())
            FROM notes n
            WHERE n.id = $3
              AND n.user_id = $2
              AND n.encrypted = FALSE
            RETURNING id
          `,
          [
            share.id,
            request.currentUser.id,
            share.noteId,
            String(share.code || ''),
            toTimestamp(share.expireAt),
            Number(share.viewCount || 0),
            toTimestamp(share.createdAt)
          ]
        )

        if (!result.rows.length) {
          throw createHttpError('分享记录引用的笔记不可用，未执行导入', 400)
        }
      }

      for (const engine of customEngines) {
        await client.query(
          `
            INSERT INTO custom_search_engines (
              id,
              user_id,
              name,
              icon,
              url,
              display_order,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), COALESCE($8, NOW()))
          `,
          [
            engine.id,
            request.currentUser.id,
            String(engine.name || 'Custom Engine'),
            normalizeEngineMonogram(engine.icon),
            String(engine.url || '').trim(),
            Number(engine.order || 0),
            toTimestamp(engine.createdAt),
            toTimestamp(engine.updatedAt)
          ]
        )
      }

      for (const setting of settings) {
        const settingValue = setting.id === 'appConfig'
          ? sanitizeRetiredSearchProviders(setting.value)
          : setting.value

        await client.query(
          `
            INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (user_id, key)
            DO UPDATE SET
              value = EXCLUDED.value,
              updated_at = NOW()
          `,
          [request.currentUser.id, setting.id, JSON.stringify(settingValue)]
        )
      }
    })

    return {
      ok: true,
      imported: {
        groups: groups.length,
        bookmarks: bookmarks.length,
        notes: notes.length,
        customEngines: customEngines.length,
        shares: shares.length,
        settings: settings.length
      }
    }
  })
}
