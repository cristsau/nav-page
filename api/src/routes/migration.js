import { config } from '../config.js'
import { withTransaction } from '../db/index.js'
import { verifyPassword } from '../lib/auth.js'
import {
  createDataRestorePreviewToken,
  createDataRestoreSafetyBackupReceipt,
  createDataRestoreStateDigest,
  validateDataRestoreRequest,
  verifyDataRestorePreviewToken,
  verifyDataRestoreSafetyBackupReceipt
} from '../lib/dataRestore.js'
import { enforceDataRestoreRateLimit } from '../lib/dataRestoreRateLimit.js'
import {
  MAX_DATA_RESTORE_NOTE_NUMBER_ID,
  MIN_DATA_RESTORE_NOTE_NUMBER_ID,
  normalizeDataRestoreNoteNumberId,
  planDataRestoreNoteNumbers
} from '../lib/dataRestoreNoteNumbers.js'
import { withNavigationTransaction } from '../lib/navigationTransactions.js'
import {
  assertAttachmentsAllowedForEncryption,
  getImgBedOrigin,
  normalizeNoteAttachments
} from '../lib/noteAttachments.js'
import {
  assertMediaBelongsToUser,
  activateReferencedMediaAssets,
  registerMediaAsset
} from '../lib/mediaAssets.js'
import {
  isValidSearchUrl,
  normalizeEngineMonogram
} from '../lib/searchEngines.js'
import {
  mergeAppConfigSecrets,
  sanitizeRetiredSearchProviders
} from '../lib/settingsSecrets.js'
import {
  recordSecurityEvent,
  recordSecurityEventBestEffort
} from '../lib/securityEvents.js'

const BACKUP_SCHEMA = 'domo-nav-backup'
const BACKUP_VERSION = 1
const DATA_RESTORE_BODY_LIMIT = 16 * 1024 * 1024
const DATA_RESTORE_MAX_PASSWORD_LENGTH = 1024
const DATA_RESTORE_MAX_TOKEN_LENGTH = 256
const DATA_RESTORE_CONFIRMATION = '恢复'
const DATA_RESTORE_SETTING_KEYS = Object.freeze([
  'appConfig',
  'theme',
  'whisperBgImage'
])
const EXCLUDED_SETTING_KEYS = new Set([
  'telegramConfig',
  'telegramUpdateOffset'
])
const EXPORTABLE_SETTING_KEYS = new Set(DATA_RESTORE_SETTING_KEYS)
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
        useServerManaged: true,
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
  return normalizeDataRestoreNoteNumberId(value)
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

function setRestoreNoStoreHeaders(reply) {
  reply.header('Cache-Control', 'no-store, max-age=0')
  reply.header('Pragma', 'no-cache')
  reply.header('Surrogate-Control', 'no-store')
}

function restoreCollectionCounts(data) {
  const counts = Object.fromEntries(
    ['groups', 'bookmarks', 'notes', 'customEngines', 'shares', 'settings', 'mediaAssets']
      .map((name) => [name, data[name].length])
  )
  counts.attachments = data.notes.reduce(
    (total, note) => total + note.attachments.length,
    0
  )
  counts.totalRecords = Object.entries(counts)
    .filter(([name]) => !['attachments', 'totalRecords'].includes(name))
    .reduce((total, [, count]) => total + count, 0)
  return counts
}

function prepareDataRestore(backup, { restoreShares, userId } = {}) {
  const validated = validateDataRestoreRequest({
    ...(backup || {}),
    restoreShares: restoreShares === true
  })
  const data = validated.data
  const importedGroupIds = new Set(data.groups.map((group) => String(group.id)))
  const importedNotesById = new Map(
    data.notes.map((note) => [String(note.id), note])
  )
  const invalidEngine = data.customEngines.find(
    (engine) => !isValidSearchUrl(engine?.url)
  )
  const invalidBookmark = data.bookmarks.find(
    (bookmark) => !isValidSearchUrl(bookmark?.url)
  )
  const invalidBookmarkGroup = data.bookmarks.find(
    (bookmark) => !importedGroupIds.has(String(bookmark.groupId))
  )
  const invalidShare = data.shares.find(
    (share) => !importedNotesById.has(String(share.noteId))
  )
  const encryptedShare = data.shares.find(
    (share) => Boolean(importedNotesById.get(String(share.noteId))?.encrypted)
  )

  if (invalidEngine) {
    throw createHttpError(
      `自定义搜索引擎「${String(invalidEngine.name || '未命名')}」的 URL 无效`,
      400
    )
  }
  if (invalidBookmark) {
    throw createHttpError(
      `导航「${String(invalidBookmark.title || '未命名')}」的 URL 无效`,
      400
    )
  }
  if (invalidBookmarkGroup) {
    throw createHttpError('导航记录必须引用本次恢复的分组', 400)
  }
  if (invalidShare) {
    throw createHttpError('分享记录必须引用本次恢复的笔记', 400)
  }
  if (encryptedShare) {
    throw createHttpError('加密笔记不能包含公开分享记录', 400)
  }

  const importedNumberIds = data.notes
    .map((note) => normalizeNoteNumberId(note?.numberId))
    .filter((numberId) => numberId !== null)
  const invalidNumberId = data.notes.find((note) => (
    note?.numberId !== null
    && note?.numberId !== undefined
    && note?.numberId !== ''
    && normalizeNoteNumberId(note.numberId) === null
  ))
  if (invalidNumberId) {
    throw createHttpError(
      `恢复的笔记数字 ID 必须是 ${MIN_DATA_RESTORE_NOTE_NUMBER_ID} 到 ${MAX_DATA_RESTORE_NOTE_NUMBER_ID} 之间的整数`,
      400
    )
  }
  if (new Set(importedNumberIds).size !== importedNumberIds.length) {
    throw createHttpError('恢复数据包含重复的笔记数字 ID', 400)
  }

  const normalizedNotes = data.notes.map((note) => {
    const attachments = normalizeNoteAttachments(note?.attachments, {
      allowedOrigin: getImgBedOrigin(config.imgBedBaseUrl),
      maxBytes: config.imgBedMaxImageBytes,
      strict: true
    })
    assertAttachmentsAllowedForEncryption(Boolean(note?.encrypted), attachments)
    for (const attachment of attachments) {
      assertMediaBelongsToUser(userId, { url: attachment.url })
    }
    return { ...note, attachments }
  })
  const referencedMediaUrls = new Set(
    normalizedNotes.flatMap((note) => note.attachments.map((attachment) => attachment.url))
  )

  const normalizedMediaAssets = []
  let ignoredMediaAssets = 0
  for (const asset of data.mediaAssets) {
    const [normalized] = normalizeNoteAttachments([asset], {
      allowedOrigin: getImgBedOrigin(config.imgBedBaseUrl),
      maxBytes: config.imgBedMaxImageBytes,
      strict: true
    })
    const upstreamId = assertMediaBelongsToUser(userId, { url: normalized.url })
    const suppliedUpstreamId = String(asset?.upstreamId || '').trim()
    if (
      suppliedUpstreamId
      && assertMediaBelongsToUser(userId, { upstreamId: suppliedUpstreamId }) !== upstreamId
    ) {
      throw createHttpError('图片 URL 与图床对象标识不一致', 400)
    }
    if (['deleted', 'missing'].includes(String(asset?.state || ''))) {
      if (referencedMediaUrls.has(normalized.url)) {
        throw createHttpError('备份中的笔记引用了已删除或缺失的图片，不能安全恢复', 400)
      }
      ignoredMediaAssets += 1
      continue
    }
    normalizedMediaAssets.push({
      ...asset,
      ...normalized,
      upstreamId,
      state: referencedMediaUrls.has(normalized.url) ? 'active' : 'orphan'
    })
  }
  const normalizedMediaUrls = normalizedMediaAssets.map((asset) => asset.url)
  const normalizedMediaUpstreamIds = normalizedMediaAssets.map((asset) => asset.upstreamId)
  if (new Set(normalizedMediaUrls).size !== normalizedMediaUrls.length) {
    throw createHttpError('图片标准化后包含重复 URL', 400)
  }
  if (new Set(normalizedMediaUpstreamIds).size !== normalizedMediaUpstreamIds.length) {
    throw createHttpError('图片标准化后包含重复图床对象标识', 400)
  }

  const sanitizedSettings = []
  let ignoredSettings = 0
  for (const setting of data.settings) {
    if (
      setting.id === 'appConfig'
      && (
        !setting.value
        || typeof setting.value !== 'object'
        || Array.isArray(setting.value)
      )
    ) {
      throw createHttpError('appConfig 设置格式无效', 400)
    }
    const sanitized = sanitizeSettingForBackendExport({
      key: setting.id,
      value: setting.value
    })
    if (sanitized.setting) sanitizedSettings.push(sanitized.setting)
    else ignoredSettings += 1
  }

  const normalizedData = {
    ...data,
    notes: normalizedNotes,
    mediaAssets: normalizedMediaAssets,
    settings: sanitizedSettings
  }
  const restore = {
    ...validated,
    data: normalizedData,
    counts: restoreCollectionCounts(normalizedData)
  }

  return {
    restore,
    ignoredSettings,
    ignoredMediaAssets,
    encryptedNotes: normalizedNotes.filter((note) => Boolean(note.encrypted)).length
  }
}

function normalizeStateCollection(value) {
  return {
    count: Number(value?.count || 0),
    fingerprint: String(value?.fingerprint || '')
  }
}

async function readDataRestoreState(client, userId) {
  const { rows } = await client.query(
    `
      SELECT
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id::text)),
              md5('')
            )
          )
          FROM nav_groups WHERE user_id = $1
        ) AS groups,
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id::text)),
              md5('')
            )
          )
          FROM nav_bookmarks WHERE user_id = $1
        ) AS bookmarks,
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id::text)),
              md5('')
            )
          )
          FROM notes WHERE user_id = $1
        ) AS notes,
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id::text)),
              md5('')
            )
          )
          FROM note_shares WHERE user_id = $1
        ) AS shares,
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id::text)),
              md5('')
            )
          )
          FROM custom_search_engines WHERE user_id = $1
        ) AS "customEngines",
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(key || ':' || xmin::text, '|' ORDER BY key)),
              md5('')
            )
          )
          FROM user_settings
          WHERE user_id = $1 AND key = ANY($2::text[])
        ) AS settings,
        (
          SELECT jsonb_build_object(
            'count', COUNT(*)::integer,
            'fingerprint', COALESCE(
              md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id::text)),
              md5('')
            )
          )
          FROM media_assets WHERE user_id = $1
        ) AS "mediaAssets"
    `,
    [userId, DATA_RESTORE_SETTING_KEYS]
  )

  return Object.fromEntries(
    ['groups', 'bookmarks', 'notes', 'customEngines', 'shares', 'settings', 'mediaAssets']
      .map((name) => [name, normalizeStateCollection(rows[0]?.[name])])
  )
}

function publicRestoreState(state) {
  return Object.fromEntries(
    Object.entries(state).map(([name, value]) => [name, value.count])
  )
}

async function findDataRestoreConflicts(client, userId, restore) {
  const { data } = restore
  const attachmentUrls = data.notes.flatMap((note) => (
    note.attachments.map((attachment) => attachment.url)
  ))
  const restoreMediaIds = data.mediaAssets.map((record) => record.id)
  const restoreMediaUrls = [...new Set([
    ...data.mediaAssets.map((record) => record.url),
    ...attachmentUrls
  ])]
  const restoreMediaUpstreamIds = [...new Set([
    ...data.mediaAssets.map((record) => record.upstreamId),
    ...attachmentUrls.map((url) => assertMediaBelongsToUser(userId, { url }))
  ])]
  const { rows } = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1 FROM nav_groups
          WHERE id = ANY($2::uuid[]) AND user_id <> $1
        ) AS groups,
        EXISTS (
          SELECT 1 FROM nav_bookmarks
          WHERE id = ANY($3::uuid[]) AND user_id <> $1
        ) AS bookmarks,
        EXISTS (
          SELECT 1 FROM notes
          WHERE id = ANY($4::uuid[]) AND user_id <> $1
        ) AS notes,
        EXISTS (
          SELECT 1 FROM custom_search_engines
          WHERE id = ANY($5::uuid[]) AND user_id <> $1
        ) AS "customEngines",
        EXISTS (
          SELECT 1 FROM note_shares
          WHERE (
            id = ANY($6::uuid[])
            OR code = ANY($7::text[])
          ) AND user_id <> $1
        ) AS shares,
        EXISTS (
          SELECT 1 FROM media_assets
          WHERE (
            id = ANY($8::uuid[])
            OR url = ANY($9::text[])
            OR upstream_id = ANY($10::text[])
          ) AND user_id <> $1
        ) AS "mediaAssets",
        EXISTS (
          SELECT 1 FROM notes
          WHERE number_id = ANY($11::bigint[]) AND user_id <> $1
        ) AS "numberIds"
    `,
    [
      userId,
      data.groups.map((record) => record.id),
      data.bookmarks.map((record) => record.id),
      data.notes.map((record) => record.id),
      data.customEngines.map((record) => record.id),
      data.shares.map((record) => record.id),
      data.shares.map((record) => record.code),
      restoreMediaIds,
      restoreMediaUrls,
      restoreMediaUpstreamIds,
      data.notes
        .map((record) => normalizeNoteNumberId(record.numberId))
        .filter((numberId) => numberId !== null)
    ]
  )

  const conflicts = rows[0] || {}
  const mediaMatches = restoreMediaUrls.length || restoreMediaIds.length
    ? await client.query(
        `
          SELECT id::text AS id, user_id::text AS user_id, url, upstream_id, state
          FROM media_assets
          WHERE user_id = $1
            AND (
              id = ANY($2::uuid[])
              OR url = ANY($3::text[])
              OR upstream_id = ANY($4::text[])
            )
        `,
        [
          userId,
          restoreMediaIds,
          restoreMediaUrls,
          restoreMediaUpstreamIds
        ]
      )
    : { rows: [] }
  const importedMediaById = new Map(data.mediaAssets.map((record) => [record.id, record]))
  const importedMediaByUrl = new Map(data.mediaAssets.map((record) => [record.url, record]))
  const importedMediaByUpstreamId = new Map(
    data.mediaAssets.map((record) => [record.upstreamId, record])
  )
  for (const url of attachmentUrls) {
    const upstreamId = assertMediaBelongsToUser(userId, { url })
    const attachmentIdentity = { url, upstreamId }
    if (!importedMediaByUrl.has(url)) importedMediaByUrl.set(url, attachmentIdentity)
    if (!importedMediaByUpstreamId.has(upstreamId)) {
      importedMediaByUpstreamId.set(upstreamId, attachmentIdentity)
    }
  }
  const sameAccountMediaIdentityConflict = mediaMatches.rows.some((record) => {
    if (String(record.user_id) !== String(userId)) return false
    const byId = importedMediaById.get(String(record.id))
    const byUrl = importedMediaByUrl.get(String(record.url))
    const byUpstreamId = importedMediaByUpstreamId.get(String(record.upstream_id))
    return (
      (byId && (byId.url !== record.url || byId.upstreamId !== record.upstream_id))
      || (byUrl && byUrl.upstreamId !== record.upstream_id)
      || (byUpstreamId && byUpstreamId.url !== record.url)
    )
  })
  const unavailableMediaIdentity = mediaMatches.rows.some((record) => (
    ['deleted', 'missing'].includes(String(record.state || ''))
  ))
  const labels = {
    groups: '分组 ID',
    bookmarks: '导航 ID',
    notes: '笔记 ID',
    customEngines: '搜索引擎 ID',
    shares: '分享 ID 或分享码',
    mediaAssets: '图片 ID 或图床地址',
    numberIds: '笔记数字 ID'
  }
  const messages = Object.entries(labels)
    .filter(([name]) => conflicts[name] === true)
    .map(([name, label]) => ({
      code: `restore-conflict-${name}`,
      level: 'danger',
      message: `备份中的${label}已被其他账号使用，不能执行恢复。`
    }))
  if (sameAccountMediaIdentityConflict) {
    messages.push({
      code: 'restore-conflict-media-identity',
      level: 'danger',
      message: '备份图片与当前图片目录的 ID、URL 或图床对象标识不一致，不能执行恢复。'
    })
  }
  if (unavailableMediaIdentity) {
    messages.push({
      code: 'restore-conflict-media-unavailable',
      level: 'danger',
      message: '备份引用的图片已标记为删除或缺失，备份不含图片二进制，不能静默复活。'
    })
  }
  return messages
}

async function findCascadeOwnershipConflicts(client, userId) {
  const { rows } = await client.query(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM nav_bookmarks child
          JOIN nav_groups parent ON parent.id = child.group_id
          WHERE parent.user_id = $1 AND child.user_id <> $1
        ) AS bookmarks,
        EXISTS (
          SELECT 1
          FROM note_shares child
          JOIN notes parent ON parent.id = child.note_id
          WHERE parent.user_id = $1 AND child.user_id <> $1
        ) AS shares,
        EXISTS (
          SELECT 1
          FROM note_reminders child
          JOIN notes parent ON parent.id = child.note_id
          WHERE parent.user_id = $1 AND child.user_id <> $1
        ) AS reminders
    `,
    [userId]
  )
  const conflicts = rows[0] || {}
  const labels = {
    bookmarks: '其他账号的导航错误引用了当前账号分组',
    shares: '其他账号的分享错误引用了当前账号笔记',
    reminders: '其他账号的提醒错误引用了当前账号笔记'
  }
  return Object.entries(labels)
    .filter(([name]) => conflicts[name] === true)
    .map(([name, message]) => ({
      code: `restore-conflict-cascade-${name}`,
      level: 'danger',
      message: `${message}；为避免级联删除，恢复已阻断，请先修复数据归属。`
    }))
}

function buildRestoreWarnings({
  restore,
  encryptedNotes,
  ignoredSettings,
  ignoredMediaAssets,
  currentState
}) {
  const warnings = [
    {
      code: 'replace-mode',
      level: 'danger',
      message: '恢复会替换当前分组、导航、笔记、搜索引擎和允许导入的设置，不会与现有数据合并。'
    },
    {
      code: 'external-images',
      level: 'warning',
      message: '备份只包含图床地址和目录信息，不包含图片二进制；现有图片目录会保留并与备份目录合并。'
    },
    {
      code: 'secrets-preserved',
      level: 'info',
      message: 'API 密钥、Telegram 配置、密码和未知设置不会从备份导入；目标账号现有密钥仅在目标地址未变化时保留。'
    }
  ]
  if (encryptedNotes > 0) {
    warnings.push({
      code: 'encrypted-notes',
      level: 'warning',
      message: `${encryptedNotes} 条加密笔记仍需要原加密密码才能解密。`
    })
  }
  if (restore.restoreShares) {
    warnings.push({
      code: 'public-shares-enabled',
      level: 'danger',
      message: `${restore.counts.shares} 个公开分享链接将重新生效。`
    })
  } else if (restore.backupCounts.shares > 0) {
    warnings.push({
      code: 'public-shares-skipped',
      level: 'info',
      message: `备份内 ${restore.backupCounts.shares} 个公开分享默认不恢复。`
    })
  }
  if (ignoredSettings > 0) {
    warnings.push({
      code: 'settings-skipped',
      level: 'info',
      message: `${ignoredSettings} 项非白名单或敏感设置已忽略。`
    })
  }
  if (ignoredMediaAssets > 0) {
    warnings.push({
      code: 'unavailable-media-skipped',
      level: 'info',
      message: `${ignoredMediaAssets} 条已删除或缺失且未被笔记引用的图片墓碑不会恢复。`
    })
  }
  if (currentState.mediaAssets.count > 0) {
    warnings.push({
      code: 'media-catalog-preserved',
      level: 'info',
      message: `当前 ${currentState.mediaAssets.count} 条图片目录记录不会被删除。`
    })
  }
  return warnings
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

function mapBackendExportMediaAsset(record) {
  return {
    id: record.id,
    upstreamId: record.upstream_id,
    url: record.url,
    name: record.name,
    mime: record.mime,
    size: Number(record.size || 0),
    source: record.source,
    retention: record.retention,
    state: record.state,
    deleteAttempts: Number(record.delete_attempts || 0),
    createdAt: toTimestamp(record.created_at),
    updatedAt: toTimestamp(record.updated_at),
    deletedAt: toTimestamp(record.deleted_at)
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
  const mediaAssetsResult = await client.query(
    `
      SELECT *
      FROM media_assets
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    params
  )

  const groups = groupsResult.rows.map(mapBackendExportGroup)
  const bookmarks = bookmarksResult.rows.map(mapBackendExportBookmark)
  const notes = notesResult.rows.map(mapBackendExportNote)
  const shares = sharesResult.rows.map(mapBackendExportShare)
  const customEngines = enginesResult.rows.map(mapBackendExportEngine)
  const mediaAssets = mediaAssetsResult.rows.map(mapBackendExportMediaAsset)
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
    mediaAssets: mediaAssets.length,
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
          + counts.mediaAssets
        )
      },
      attachments: {
        count: counts.attachments,
        binaryIncluded: false,
        content: 'external-url-metadata'
      },
      mediaLibrary: {
        count: counts.mediaAssets,
        binaryIncluded: false,
        content: 'external-object-catalog-metadata',
        credentialsIncluded: false
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
      mediaAssets,
      shares,
      settings
    }
  }
}

function cloudRestoreEnvelope(backup) {
  return {
    source: 'cloud-backup',
    schema: backup.schema,
    version: backup.version,
    exportedAt: backup.exportedAt || null,
    manifest: backup.manifest,
    data: backup.data
  }
}

function assessBackendExportRestoreCompatibility(backup, { userId } = {}) {
  try {
    const envelope = cloudRestoreEnvelope(backup)
    prepareDataRestore(envelope, {
      restoreShares: true,
      userId
    })
    const payloadBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
    const requestBytes = Buffer.byteLength(JSON.stringify({
      backup: envelope,
      mode: 'replace',
      restoreShares: true,
      planToken: '0'.repeat(DATA_RESTORE_MAX_TOKEN_LENGTH),
      backupReceipt: '0'.repeat(DATA_RESTORE_MAX_TOKEN_LENGTH),
      currentPassword: '\u0000'.repeat(DATA_RESTORE_MAX_PASSWORD_LENGTH),
      confirmation: DATA_RESTORE_CONFIRMATION
    }), 'utf8')
    if (requestBytes > DATA_RESTORE_BODY_LIMIT) {
      return {
        restorable: false,
        payloadBytes,
        requestBytes,
        limitBytes: DATA_RESTORE_BODY_LIMIT,
        reason: '当前完整备份超过第 1 版一键恢复请求上限'
      }
    }
    return {
      restorable: true,
      payloadBytes,
      requestBytes,
      limitBytes: DATA_RESTORE_BODY_LIMIT,
      reason: ''
    }
  } catch (error) {
    return {
      restorable: false,
      payloadBytes: null,
      requestBytes: null,
      limitBytes: DATA_RESTORE_BODY_LIMIT,
      reason: String(error?.message || '当前完整备份不符合第 1 版恢复约束')
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

    return {
      ...backup,
      restoreCompatibility: assessBackendExportRestoreCompatibility(backup, {
        userId: request.currentUser.id
      })
    }
  })

  fastify.get('/migration/restore/safety-backup', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    setRestoreNoStoreHeaders(reply)

    const rateLimitError = await enforceDataRestoreRateLimit(request, reply, {
      secret: config.rateLimitKeySecret
    })
    if (rateLimitError) return rateLimitError

    const snapshot = await withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      return {
        backup: await buildBackendExport(client, request.currentUser.id),
        currentState: await readDataRestoreState(client, request.currentUser.id)
      }
    })
    const restoreCompatibility = assessBackendExportRestoreCompatibility(
      snapshot.backup,
      { userId: request.currentUser.id }
    )
    if (!restoreCompatibility.restorable) {
      reply.code(409)
      return {
        error: `当前云端备份已完整生成，但不能用于第 1 版一键恢复：${restoreCompatibility.reason}`,
        code: 'restore_safety_backup_incompatible',
        restoreCompatibility
      }
    }

    let receipt
    try {
      receipt = createDataRestoreSafetyBackupReceipt({
        backup: snapshot.backup,
        userId: request.currentUser.id,
        sessionId: request.session.id,
        currentStateDigest: createDataRestoreStateDigest(snapshot.currentState),
        secret: config.rateLimitKeySecret
      })
    } catch (error) {
      request.log.error(error, 'failed to create restore safety backup receipt')
      reply.code(503)
      return { error: '恢复前安全备份服务暂时不可用' }
    }

    return {
      ok: true,
      backup: {
        ...snapshot.backup,
        restoreCompatibility
      },
      backupReceipt: receipt.receipt,
      expiresAt: receipt.expiresAt
    }
  })

  fastify.post('/migration/restore/preview', {
    bodyLimit: DATA_RESTORE_BODY_LIMIT
  }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    setRestoreNoStoreHeaders(reply)

    const rateLimitError = await enforceDataRestoreRateLimit(request, reply, {
      secret: config.rateLimitKeySecret
    })
    if (rateLimitError) return rateLimitError
    if (request.body?.mode !== 'replace') {
      reply.code(400)
      return { error: '恢复模式必须明确为 replace' }
    }

    let prepared
    try {
      prepared = prepareDataRestore(request.body?.backup, {
        restoreShares: request.body?.restoreShares,
        userId: request.currentUser.id
      })
    } catch (error) {
      reply.code(Number(error?.statusCode) || 400)
      return { error: String(error?.message || '恢复文件无效') }
    }

    const { currentState, blockingErrors } = await withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const [restoreConflicts, cascadeConflicts] = await Promise.all([
        findDataRestoreConflicts(client, request.currentUser.id, prepared.restore),
        findCascadeOwnershipConflicts(client, request.currentUser.id)
      ])
      return {
        currentState: await readDataRestoreState(client, request.currentUser.id),
        blockingErrors: [...cascadeConflicts, ...restoreConflicts]
      }
    })
    const currentStateDigest = createDataRestoreStateDigest(currentState)
    let previewToken = { token: '', expiresAt: null }
    if (!blockingErrors.length) {
      try {
        previewToken = createDataRestorePreviewToken({
          restore: prepared.restore,
          userId: request.currentUser.id,
          sessionId: request.session.id,
          currentStateDigest,
          secret: config.rateLimitKeySecret
        })
      } catch (error) {
        request.log.error(error, 'failed to create data-restore preview token')
        reply.code(503)
        return { error: '数据恢复确认服务暂时不可用' }
      }
    }

    return {
      ok: true,
      preview: {
        current: publicRestoreState(currentState),
        incoming: prepared.restore.counts,
        backupCounts: prepared.restore.backupCounts,
        warnings: buildRestoreWarnings({
          ...prepared,
          currentState
        }),
        blockingErrors,
        planToken: previewToken.token,
        expiresAt: previewToken.expiresAt,
        encryptedNotes: prepared.encryptedNotes,
        ignoredSettings: prepared.ignoredSettings,
        ignoredMediaAssets: prepared.ignoredMediaAssets,
        preservedMediaAssets: currentState.mediaAssets.count
      }
    }
  })

  fastify.post('/migration/import-local', {
    bodyLimit: DATA_RESTORE_BODY_LIMIT
  }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    setRestoreNoStoreHeaders(reply)
    reply.code(428)
    return {
      error: '请先预览恢复内容并完成当前密码确认',
      code: 'restore_preview_required'
    }
  })

  fastify.post('/migration/restore/apply', {
    bodyLimit: DATA_RESTORE_BODY_LIMIT
  }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    setRestoreNoStoreHeaders(reply)

    const rateLimitError = await enforceDataRestoreRateLimit(request, reply, {
      secret: config.rateLimitKeySecret
    })
    if (rateLimitError) return rateLimitError
    if (
      request.body?.mode !== 'replace'
      || request.body?.confirmation !== DATA_RESTORE_CONFIRMATION
      || !String(request.body?.currentPassword || '')
      || !String(request.body?.planToken || '')
      || !String(request.body?.backupReceipt || '')
      || String(request.body?.currentPassword || '').length > DATA_RESTORE_MAX_PASSWORD_LENGTH
      || String(request.body?.planToken || '').length > DATA_RESTORE_MAX_TOKEN_LENGTH
      || String(request.body?.backupReceipt || '').length > DATA_RESTORE_MAX_TOKEN_LENGTH
    ) {
      reply.code(400)
      return {
        error: '请完成替换模式、恢复前安全备份、当前密码和确认文字验证',
        code: 'invalid_restore_confirmation'
      }
    }

    let prepared
    try {
      prepared = prepareDataRestore(request.body?.backup, {
        restoreShares: request.body?.restoreShares,
        userId: request.currentUser.id
      })
    } catch (error) {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'account.data.restore',
        outcome: 'denied',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'account_data'
      }, request.log)
      reply.code(Number(error?.statusCode) || 400)
      return { error: String(error?.message || '恢复文件无效') }
    }

    const { restore, ignoredSettings } = prepared
    const {
      groups,
      bookmarks,
      notes,
      customEngines,
      shares,
      settings,
      mediaAssets
    } = restore.data
    const importedAttachmentsByNoteId = new Map(
      notes.map((note) => [String(note.id), note.attachments])
    )

    let result
    try {
      result = await withNavigationTransaction(request.currentUser.id, async (client) => {
        const userResult = await client.query(
          `
            SELECT password_hash
            FROM users
            WHERE id = $1
              AND status = 'approved'
            FOR UPDATE
          `,
          [request.currentUser.id]
        )
        const sessionResult = await client.query(
          `
            SELECT id
            FROM sessions
            WHERE id = $1
              AND user_id = $2
              AND expires_at > NOW()
            FOR UPDATE
          `,
          [request.session.id, request.currentUser.id]
        )
        if (!userResult.rows.length || !sessionResult.rows.length) {
          return { status: 'invalid-session' }
        }
        if (
          !await verifyPassword(
            request.body.currentPassword,
            userResult.rows[0].password_hash
          )
        ) {
          return { status: 'invalid-password' }
        }

        await client.query(
          "SET LOCAL statement_timeout = '60s'"
        )
        await client.query(
          `
            LOCK TABLE
              nav_groups,
              nav_bookmarks,
              notes,
              note_shares,
              note_reminders,
              custom_search_engines,
              user_settings,
              media_assets
            IN SHARE ROW EXCLUSIVE MODE
          `
        )
        const cascadeConflicts = await findCascadeOwnershipConflicts(
          client,
          request.currentUser.id
        )
        if (cascadeConflicts.length) {
          return {
            status: 'conflict',
            error: cascadeConflicts[0].message
          }
        }
        const currentState = await readDataRestoreState(client, request.currentUser.id)
        const currentStateDigest = createDataRestoreStateDigest(currentState)
        const plan = verifyDataRestorePreviewToken({
          token: request.body.planToken,
          restore,
          userId: request.currentUser.id,
          sessionId: request.session.id,
          currentStateDigest,
          secret: config.rateLimitKeySecret
        })
        if (!plan.valid) {
          return {
            status: plan.reason === 'expired' ? 'expired-plan' : 'stale-plan'
          }
        }
        const safetyBackup = verifyDataRestoreSafetyBackupReceipt({
          receipt: request.body.backupReceipt,
          userId: request.currentUser.id,
          sessionId: request.session.id,
          currentStateDigest,
          secret: config.rateLimitKeySecret
        })
        if (!safetyBackup.valid) {
          return {
            status: safetyBackup.reason === 'expired'
              ? 'expired-backup-receipt'
              : 'stale-backup-receipt'
          }
        }

        const blockingErrors = await findDataRestoreConflicts(
          client,
          request.currentUser.id,
          restore
        )
        if (blockingErrors.length) {
          return {
            status: 'conflict',
            error: blockingErrors[0].message
          }
        }

        const existingSettingsResult = await client.query(
          `
            SELECT key, value
            FROM user_settings
            WHERE user_id = $1
              AND key = ANY($2::text[])
            FOR UPDATE
          `,
          [request.currentUser.id, DATA_RESTORE_SETTING_KEYS]
        )
        const existingSettings = new Map(
          existingSettingsResult.rows.map((setting) => [setting.key, setting.value])
        )
        const incomingSettingKeys = new Set(settings.map((setting) => setting.id))
        const settingKeysToReplace = DATA_RESTORE_SETTING_KEYS.filter((key) => (
          key !== 'appConfig' || incomingSettingKeys.has(key)
        ))

        const noteNumberStateResult = await client.query(
          `
            SELECT
              seq.last_value::text AS last_value,
              seq.is_called,
              (SELECT MAX(number_id)::text FROM notes) AS current_maximum
            FROM notes_number_id_seq AS seq
          `
        )
        let noteNumberPlan
        try {
          noteNumberPlan = planDataRestoreNoteNumbers(notes, {
            sequenceLastValue: noteNumberStateResult.rows[0]?.last_value,
            sequenceIsCalled: noteNumberStateResult.rows[0]?.is_called === true,
            currentMaximum: noteNumberStateResult.rows[0]?.current_maximum
          })
        } catch (error) {
          return {
            status: 'conflict',
            error: String(error?.message || '笔记数字 ID 无法安全恢复')
          }
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
              AND key = ANY($2::text[])
          `,
          [request.currentUser.id, settingKeysToReplace]
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

        for (const mediaAsset of mediaAssets) {
          await registerMediaAsset(client, request.currentUser.id, {
            id: mediaAsset.id,
            url: mediaAsset.url,
            name: mediaAsset.name,
            mime: mediaAsset.mime,
            size: Number(mediaAsset.size),
            createdAt: mediaAsset.createdAt
          }, {
            source: mediaAsset.source,
            retention: mediaAsset.retention,
            state: mediaAsset.state
          })
          const reconciledMedia = await client.query(
            `
              UPDATE media_assets
              SET state = $4,
                  delete_attempts = 0,
                  delete_requested_at = NULL,
                  last_delete_error = '',
                  deletion_disposition = NULL,
                  deletion_source_deleted = NULL,
                  deletion_detached = NULL,
                  deletion_legacy = NULL,
                  deletion_already_missing = NULL,
                  deletion_cache_invalidated = NULL,
                  deletion_cache_purge_configured = NULL,
                  deletion_cache_purge_attempted = NULL,
                  deletion_cache_purge_succeeded = NULL,
                  deletion_local_cache_invalidated = NULL,
                  deleted_at = NULL,
                  updated_at = NOW()
              WHERE user_id = $1
                AND url = $2
                AND upstream_id = $3
                AND state NOT IN ('deleted', 'missing')
              RETURNING id
            `,
            [
              request.currentUser.id,
              mediaAsset.url,
              mediaAsset.upstreamId,
              mediaAsset.state
            ]
          )
          if (!reconciledMedia.rows.length) {
            throw createHttpError('图片目录状态已变化，请重新预览后再恢复', 409)
          }
        }

        for (const [noteIndex, note] of notes.entries()) {
          const noteAttachments = importedAttachmentsByNoteId.get(String(note.id || '')) || []
          await activateReferencedMediaAssets(
            client,
            request.currentUser.id,
            noteAttachments,
            { source: 'reconciled', retention: 'auto', allowMissing: true }
          )
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
                $3::bigint,
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
              noteNumberPlan.numberIds[noteIndex],
              note.type === 'diary' ? 'diary' : 'memo',
              String(note.title || 'Untitled'),
              String(note.content || ''),
              Boolean(note.encrypted),
              String(note.password || ''),
              Boolean(note.pinned),
              toJsonArray(note.tags),
              JSON.stringify(noteAttachments),
              note.type === 'diary' ? toDateOnly(note.entryDate) : null,
              note.type === 'diary' ? String(note.mood || '').slice(0, 40) : '',
              note.type === 'memo' ? toTimestamp(note.dueAt) : null,
              note.type === 'memo' && Boolean(note.completed),
              toTimestamp(note.createdAt),
              toTimestamp(note.updatedAt)
            ]
          )
        }

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
            ? mergeAppConfigSecrets(
                setting.value,
                existingSettings.get('appConfig') || {}
              )
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

        await recordSecurityEvent({
          client,
          request,
          eventType: 'account.data.restore',
          outcome: 'success',
          actorUserId: request.currentUser.id,
          subjectUserId: request.currentUser.id,
          resourceType: 'account_data',
          affectedCount: restore.counts.totalRecords
        })

        if (noteNumberPlan.shouldAdvanceSequence) {
          await client.query(
            `
              SELECT setval(
                'notes_number_id_seq',
                GREATEST(last_value, $1::bigint),
                TRUE
              )
              FROM notes_number_id_seq
            `,
            [noteNumberPlan.highWater]
          )
        }

        return { status: 'restored' }
      })
    } catch (error) {
      request.log.error(error, 'data restore rolled back')
      await recordSecurityEventBestEffort({
        request,
        eventType: 'account.data.restore',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'account_data'
      }, request.log)
      const statusCode = Number(error?.statusCode)
      reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500)
      return {
        error: statusCode >= 400 && statusCode < 500
          ? String(error.message)
          : '恢复失败，当前云端数据未更改'
      }
    }

    if (result.status !== 'restored') {
      const invalidPassword = result.status === 'invalid-password'
      const invalidSession = result.status === 'invalid-session'
      await recordSecurityEventBestEffort({
        request,
        eventType: 'account.data.restore',
        outcome: invalidPassword ? 'failure' : 'denied',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'account_data'
      }, request.log)
      reply.code(invalidSession ? 401 : invalidPassword ? 400 : 409)
      const failure = {
        'invalid-session': {
          error: '登录状态已失效，请重新登录',
          code: 'session_expired'
        },
        'invalid-password': {
          error: '当前密码不正确',
          code: 'invalid_current_password'
        },
        'expired-plan': {
          error: '恢复预览已过期，请重新预览',
          code: 'restore_preview_expired'
        },
        'expired-backup-receipt': {
          error: '恢复前安全备份回执已过期，请重新下载当前云端数据',
          code: 'restore_backup_receipt_expired'
        },
        'stale-backup-receipt': {
          error: '恢复前安全备份回执与当前数据不一致，请重新下载当前云端数据',
          code: 'restore_backup_receipt_changed'
        },
        conflict: {
          error: result.error,
          code: 'restore_conflict'
        },
        'stale-plan': {
          error: '当前云端数据已变化，请重新预览后再恢复',
          code: 'restore_state_changed'
        }
      }[result.status] || {
        error: '当前云端数据已变化，请重新预览后再恢复',
        code: 'restore_state_changed'
      }
      return {
        error: failure.error,
        code: failure.code
      }
    }

    return {
      ok: true,
      imported: {
        groups: groups.length,
        bookmarks: bookmarks.length,
        notes: notes.length,
        customEngines: customEngines.length,
        shares: shares.length,
        settings: settings.length,
        mediaAssets: mediaAssets.length
      },
      ignoredSettings,
      preservedMediaAssets: true,
      sharesRestored: restore.restoreShares
    }
  })
}
