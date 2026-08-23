import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const DATA_RESTORE_SOURCES = Object.freeze({
  LOCAL_BROWSER: 'local-browser',
  CLOUD_BACKUP: 'cloud-backup'
})

export const DATA_RESTORE_PREVIEW_TTL_MS = 10 * 60 * 1000
export const DATA_RESTORE_BACKUP_RECEIPT_TTL_MS = 10 * 60 * 1000

const REQUIRED_COLLECTIONS = Object.freeze([
  'groups',
  'bookmarks',
  'notes',
  'customEngines',
  'shares',
  'settings'
])

const OPTIONAL_COLLECTIONS = Object.freeze(['mediaAssets'])

const COLLECTION_LIMITS = Object.freeze({
  groups: 200,
  bookmarks: 2_000,
  notes: 1_000,
  customEngines: 100,
  shares: 1_000,
  settings: 100,
  mediaAssets: 2_000
})

const MAX_TOTAL_RECORDS = 5_000
const MAX_ATTACHMENTS = 2_000
const MAX_RESTORE_WORK_UNITS = 8_000
const CLOUD_BACKUP_SCHEMA = 'domo-nav-backup'
const CLOUD_BACKUP_VERSION = 1
const TOKEN_VERSION = 'v1'
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const THEME_VALUES = new Set(['light', 'dark', 'system'])
const LEGACY_THEME_VALUES = new Map([
  ['warm-dark', 'dark'],
  ['warm-light', 'light']
])
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:gif|jpeg|png|webp);base64,/i

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalidRestore(message) {
  const error = new TypeError(message)
  error.statusCode = 400
  error.code = 'invalid_restore_payload'
  return error
}

function canonicalJson(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw invalidRestore('恢复数据包含无效数字')
      return JSON.stringify(value)
    case 'object': {
      if (!isPlainObject(value)) throw invalidRestore('恢复数据包含不支持的对象')
      const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      return `{${entries.join(',')}}`
    }
    default:
      throw invalidRestore('恢复数据包含不支持的值')
  }
}

function boundedNow(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('now must be a non-negative integer timestamp')
  }
  return parsed
}

function normalizeSecret(value) {
  const secret = String(value || '')
  if (secret.length < 32) throw new TypeError('restore preview secret is required')
  return secret
}

function normalizeUserId(value) {
  const userId = String(value || '').trim()
  if (!userId) throw new TypeError('restore preview user is required')
  return userId
}

function normalizeBinding(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 256) {
    throw new TypeError(`${name} is required`)
  }
  return normalized
}

function tokenMessage({
  expiresAt,
  userId,
  sessionId,
  currentStateDigest,
  source,
  schema,
  version,
  data
}) {
  return [
    'domo-nav-data-restore',
    TOKEN_VERSION,
    String(expiresAt),
    normalizeUserId(userId),
    normalizeBinding(sessionId, 'restore preview session'),
    normalizeBinding(currentStateDigest, 'restore current state digest'),
    source,
    schema || '',
    String(version),
    canonicalJson(data)
  ].join('\n')
}

function tokenMac(message, secret) {
  return createHmac('sha256', normalizeSecret(secret))
    .update(message)
    .digest('hex')
}

function safetyBackupMessage({
  expiresAt,
  userId,
  sessionId,
  currentStateDigest,
  backupDigest
}) {
  return [
    'domo-nav-restore-safety-backup',
    TOKEN_VERSION,
    String(expiresAt),
    normalizeUserId(userId),
    normalizeBinding(sessionId, 'restore safety backup session'),
    currentStateDigest,
    backupDigest
  ].join('\n')
}

function validateUuidRecords(data) {
  for (const name of ['groups', 'bookmarks', 'notes', 'customEngines', 'shares', 'mediaAssets']) {
    const ids = new Set()
    for (const record of data[name]) {
      if (!isPlainObject(record)) throw invalidRestore(`${name} 包含无效记录`)
      const id = String(record.id || '').trim()
      if (!UUID_PATTERN.test(id)) throw invalidRestore(`${name} 包含无效 ID`)
      const canonicalId = id.toLowerCase()
      if (ids.has(canonicalId)) throw invalidRestore(`${name} 包含重复 ID`)
      ids.add(canonicalId)
    }
  }

  for (const bookmark of data.bookmarks) {
    if (!UUID_PATTERN.test(String(bookmark.groupId || '').trim())) {
      throw invalidRestore('bookmarks 包含无效分组 ID')
    }
  }
  for (const share of data.shares) {
    if (!UUID_PATTERN.test(String(share.noteId || '').trim())) {
      throw invalidRestore('shares 包含无效笔记 ID')
    }
    if (!/^[A-Za-z0-9]{8,128}$/.test(String(share.code || '').trim())) {
      throw invalidRestore('shares 包含无效分享码')
    }
  }
  const shareCodes = data.shares.map((share) => String(share.code).trim())
  if (new Set(shareCodes).size !== shareCodes.length) {
    throw invalidRestore('shares 包含重复分享码')
  }
  for (const setting of data.settings) {
    if (!isPlainObject(setting)) throw invalidRestore('settings 包含无效记录')
    const id = String(setting.id || '').trim()
    if (!id || id.length > 128) throw invalidRestore('settings 包含无效设置 ID')
  }
  const settingIds = data.settings.map((setting) => String(setting.id).trim())
  if (new Set(settingIds).size !== settingIds.length) {
    throw invalidRestore('settings 包含重复设置 ID')
  }
  const mediaUrls = data.mediaAssets.map((asset) => String(asset.url || '').trim())
  if (mediaUrls.some((url) => !url) || new Set(mediaUrls).size !== mediaUrls.length) {
    throw invalidRestore('mediaAssets 包含空白或重复 URL')
  }
  const mediaUpstreamIds = data.mediaAssets
    .map((asset) => String(asset.upstreamId || '').trim())
    .filter(Boolean)
  if (new Set(mediaUpstreamIds).size !== mediaUpstreamIds.length) {
    throw invalidRestore('mediaAssets 包含重复图床对象标识')
  }
}

function validateOptionalInteger(value, label, { min = INT32_MIN, max = INT32_MAX } = {}) {
  if (value === undefined || value === null || value === '') return
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw invalidRestore(`${label} 必须是 ${min} 到 ${max} 之间的整数`)
  }
}

function validateOptionalBoolean(value, label) {
  if (value !== undefined && value !== null && typeof value !== 'boolean') {
    throw invalidRestore(`${label} 必须是布尔值`)
  }
}

function validateOptionalTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return
  const numericTimestamp = typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  const isoTimestamp = typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value)
  if ((!numericTimestamp && !isoTimestamp) || Number.isNaN(new Date(value).getTime())) {
    throw invalidRestore(`${label} 必须是合法的 ISO 时间或毫秒时间戳`)
  }
}

function validateOptionalDateOnly(value, label) {
  if (value === undefined || value === null || value === '') return
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
    throw invalidRestore(`${label} 必须是 YYYY-MM-DD 日期`)
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalidRestore(`${label} 不是合法日期`)
  }
}

function validateRestoreScalarFields(data) {
  for (const group of data.groups) {
    validateOptionalInteger(group.order, '分组顺序')
    validateOptionalBoolean(group.collapsed, '分组折叠状态')
    validateOptionalTimestamp(group.createdAt, '分组创建时间')
    validateOptionalTimestamp(group.updatedAt, '分组更新时间')
  }
  for (const bookmark of data.bookmarks) {
    validateOptionalInteger(bookmark.order, '导航顺序')
    validateOptionalTimestamp(bookmark.createdAt, '导航创建时间')
    validateOptionalTimestamp(bookmark.updatedAt, '导航更新时间')
  }
  for (const note of data.notes) {
    if (note.type !== undefined && !['memo', 'diary'].includes(note.type)) {
      throw invalidRestore('笔记类型必须是 memo 或 diary')
    }
    for (const [field, label] of [
      ['encrypted', '笔记加密状态'],
      ['pinned', '笔记置顶状态'],
      ['completed', '备忘录完成状态']
    ]) {
      validateOptionalBoolean(note[field], label)
    }
    validateOptionalDateOnly(note.entryDate, '日记日期')
    validateOptionalTimestamp(note.dueAt, '备忘录截止时间')
    validateOptionalTimestamp(note.createdAt, '笔记创建时间')
    validateOptionalTimestamp(note.updatedAt, '笔记更新时间')
  }
  for (const engine of data.customEngines) {
    validateOptionalInteger(engine.order, '搜索引擎顺序')
    validateOptionalTimestamp(engine.createdAt, '搜索引擎创建时间')
    validateOptionalTimestamp(engine.updatedAt, '搜索引擎更新时间')
  }
  for (const share of data.shares) {
    validateOptionalInteger(share.viewCount, '分享浏览次数', { min: 0 })
    validateOptionalTimestamp(share.expireAt, '分享过期时间')
    validateOptionalTimestamp(share.createdAt, '分享创建时间')
  }
  for (const asset of data.mediaAssets) {
    validateOptionalInteger(asset.size, '图片大小', { min: 1, max: Number.MAX_SAFE_INTEGER })
    validateOptionalTimestamp(asset.createdAt, '图片创建时间')
    validateOptionalTimestamp(asset.updatedAt, '图片更新时间')
    validateOptionalTimestamp(asset.deletedAt, '图片删除时间')
  }
  for (const setting of data.settings) {
    if (setting.id === 'appConfig' && !isPlainObject(setting.value)) {
      throw invalidRestore('appConfig 设置必须是对象')
    }
    const normalizedTheme = LEGACY_THEME_VALUES.get(setting.value) || setting.value
    if (setting.id === 'theme' && !THEME_VALUES.has(normalizedTheme)) {
      throw invalidRestore('theme 设置必须是 light、dark 或 system')
    }
    if (
      setting.id === 'whisperBgImage'
      && (
        typeof setting.value !== 'string'
        || (
          setting.value !== ''
          && !IMAGE_DATA_URL_PATTERN.test(setting.value)
        )
      )
    ) {
      throw invalidRestore('whisperBgImage 设置必须是图片 Data URL 或空字符串')
    }
  }
}

function normalizeDataRestoreRecords(data) {
  const normalizeId = (value) => String(value || '').trim().toLowerCase()
  const normalizeIds = (records) => records.map((record) => ({
    ...record,
    id: normalizeId(record.id)
  }))

  return {
    ...data,
    groups: normalizeIds(data.groups),
    bookmarks: data.bookmarks.map((bookmark) => ({
      ...bookmark,
      id: normalizeId(bookmark.id),
      groupId: normalizeId(bookmark.groupId)
    })),
    notes: normalizeIds(data.notes),
    customEngines: normalizeIds(data.customEngines),
    shares: data.shares.map((share) => ({
      ...share,
      id: normalizeId(share.id),
      noteId: normalizeId(share.noteId)
    })),
    settings: data.settings.map((setting) => ({
      ...setting,
      id: String(setting.id || '').trim(),
      value: String(setting.id || '').trim() === 'theme'
        ? (LEGACY_THEME_VALUES.get(setting.value) || setting.value)
        : setting.value
    })),
    mediaAssets: normalizeIds(data.mediaAssets)
  }
}

export function validateDataRestoreRequest(value = {}) {
  if (!isPlainObject(value)) throw invalidRestore('恢复请求格式无效')

  const source = String(value.source || '').trim()
  if (!Object.values(DATA_RESTORE_SOURCES).includes(source)) {
    throw invalidRestore('恢复来源无效')
  }

  const schema = String(value.schema || '').trim()
  const version = Number(value.version)
  const restoreShares = value.restoreShares === true
  if (source === DATA_RESTORE_SOURCES.CLOUD_BACKUP) {
    if (schema !== CLOUD_BACKUP_SCHEMA || version !== CLOUD_BACKUP_VERSION) {
      throw invalidRestore('只支持 DOMO NAV 第 1 版云端备份')
    }
  } else if (version !== 1) {
    throw invalidRestore('只支持第 1 版本地数据')
  }

  if (!isPlainObject(value.data)) throw invalidRestore('恢复数据必须是对象')
  const knownCollections = new Set([...REQUIRED_COLLECTIONS, ...OPTIONAL_COLLECTIONS])
  const unknownCollection = Object.keys(value.data).find((key) => !knownCollections.has(key))
  if (unknownCollection) {
    throw invalidRestore(`恢复数据包含不支持的集合：${unknownCollection}`)
  }

  for (const name of REQUIRED_COLLECTIONS) {
    if (!Array.isArray(value.data[name])) {
      throw invalidRestore(`恢复数据缺少 ${name} 数组`)
    }
  }
  for (const name of OPTIONAL_COLLECTIONS) {
    if (value.data[name] !== undefined && !Array.isArray(value.data[name])) {
      throw invalidRestore(`恢复数据的 ${name} 必须是数组`)
    }
  }

  const rawData = Object.fromEntries(
    [...REQUIRED_COLLECTIONS, ...OPTIONAL_COLLECTIONS]
      .map((name) => [name, value.data[name] || []])
  )
  const rawCounts = Object.fromEntries(
    Object.entries(rawData).map(([name, records]) => [name, records.length])
  )

  for (const [name, count] of Object.entries(rawCounts)) {
    if (count > COLLECTION_LIMITS[name]) {
      throw invalidRestore(`${name} 超过单次恢复上限 ${COLLECTION_LIMITS[name]} 条`)
    }
  }

  const rawTotalRecords = Object.values(rawCounts).reduce((total, count) => total + count, 0)
  if (rawTotalRecords > MAX_TOTAL_RECORDS) {
    throw invalidRestore(`恢复记录总数不能超过 ${MAX_TOTAL_RECORDS} 条`)
  }

  const attachments = rawData.notes.reduce((total, note) => (
    total + (Array.isArray(note?.attachments) ? note.attachments.length : 0)
  ), 0)
  if (attachments > MAX_ATTACHMENTS) {
    throw invalidRestore(`恢复附件总数不能超过 ${MAX_ATTACHMENTS} 个`)
  }
  const estimatedWorkUnits = rawTotalRecords + (attachments * 3)
  if (estimatedWorkUnits > MAX_RESTORE_WORK_UNITS) {
    throw invalidRestore(`恢复工作量不能超过 ${MAX_RESTORE_WORK_UNITS} 单位`)
  }
  const backupCounts = { ...rawCounts, attachments, totalRecords: rawTotalRecords }

  validateUuidRecords(rawData)
  const normalizedRawData = normalizeDataRestoreRecords(rawData)
  validateRestoreScalarFields(normalizedRawData)

  if (source === DATA_RESTORE_SOURCES.CLOUD_BACKUP) {
    if (!isPlainObject(value.manifest)) {
      throw invalidRestore('云端备份缺少 manifest')
    }
    if (
      String(value.manifest.schema || '').trim() !== CLOUD_BACKUP_SCHEMA
      || Number(value.manifest.version) !== CLOUD_BACKUP_VERSION
      || !isPlainObject(value.manifest.counts)
    ) {
      throw invalidRestore('云端备份 manifest 格式无效')
    }
    for (const [name, count] of Object.entries(backupCounts)) {
      if (
        name === 'mediaAssets'
        && value.data.mediaAssets === undefined
        && value.manifest.counts.mediaAssets === undefined
      ) {
        continue
      }
      if (Number(value.manifest.counts[name]) !== count) {
        throw invalidRestore(`云端备份 manifest 的 ${name} 计数不一致`)
      }
    }
  }

  const data = {
    ...normalizedRawData,
    shares: restoreShares ? normalizedRawData.shares : []
  }
  const collectionCounts = Object.fromEntries(
    Object.entries(data).map(([name, records]) => [name, records.length])
  )
  const totalRecords = Object.values(collectionCounts)
    .reduce((total, count) => total + count, 0)
  const fullCounts = { ...collectionCounts, attachments, totalRecords }

  canonicalJson(data)
  return {
    source,
    schema,
    version,
    data,
    exportedAt: String(value.exportedAt || '').trim() || null,
    restoreShares,
    counts: fullCounts,
    backupCounts
  }
}

export function createDataRestoreStateDigest(value) {
  return createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')
}

export function createDataRestoreSafetyBackupReceipt({
  backup,
  userId,
  sessionId,
  currentStateDigest,
  secret,
  now = Date.now(),
  ttlMs = DATA_RESTORE_BACKUP_RECEIPT_TTL_MS
}) {
  const currentTime = boundedNow(now)
  const ttl = Number(ttlMs)
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > DATA_RESTORE_BACKUP_RECEIPT_TTL_MS) {
    throw new TypeError('restore safety backup ttl is invalid')
  }
  if (!SHA256_PATTERN.test(String(currentStateDigest || ''))) {
    throw new TypeError('restore safety backup state digest is invalid')
  }
  const backupDigest = createDataRestoreStateDigest(backup)
  const expiresAt = currentTime + ttl
  const message = safetyBackupMessage({
    expiresAt,
    userId,
    sessionId,
    currentStateDigest,
    backupDigest
  })
  const mac = tokenMac(message, secret)
  return {
    receipt: [
      TOKEN_VERSION,
      expiresAt,
      currentStateDigest,
      backupDigest,
      mac
    ].join('.'),
    expiresAt: new Date(expiresAt).toISOString(),
    backupDigest
  }
}

export function verifyDataRestoreSafetyBackupReceipt({
  receipt,
  userId,
  sessionId,
  currentStateDigest,
  secret,
  now = Date.now()
}) {
  const parts = String(receipt || '').split('.')
  if (
    parts.length !== 5
    || parts[0] !== TOKEN_VERSION
    || !/^\d+$/.test(parts[1])
    || !SHA256_PATTERN.test(parts[2])
    || !SHA256_PATTERN.test(parts[3])
    || !SHA256_PATTERN.test(parts[4])
  ) {
    return { valid: false, reason: 'invalid' }
  }

  const expiresAt = Number(parts[1])
  const currentTime = boundedNow(now)
  if (
    !Number.isSafeInteger(expiresAt)
    || expiresAt <= currentTime
    || expiresAt > currentTime + DATA_RESTORE_BACKUP_RECEIPT_TTL_MS
  ) {
    return { valid: false, reason: expiresAt <= currentTime ? 'expired' : 'invalid' }
  }
  if (parts[2] !== String(currentStateDigest || '')) {
    return { valid: false, reason: 'mismatch' }
  }

  const expected = tokenMac(safetyBackupMessage({
    expiresAt,
    userId,
    sessionId,
    currentStateDigest: parts[2],
    backupDigest: parts[3]
  }), secret)
  const receivedBuffer = Buffer.from(parts[4], 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return timingSafeEqual(receivedBuffer, expectedBuffer)
    ? {
        valid: true,
        reason: null,
        expiresAt: new Date(expiresAt).toISOString(),
        backupDigest: parts[3]
      }
    : { valid: false, reason: 'mismatch' }
}

export function createDataRestorePreviewToken({
  restore,
  userId,
  sessionId,
  currentStateDigest,
  secret,
  now = Date.now(),
  ttlMs = DATA_RESTORE_PREVIEW_TTL_MS
}) {
  const currentTime = boundedNow(now)
  const ttl = Number(ttlMs)
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > DATA_RESTORE_PREVIEW_TTL_MS) {
    throw new TypeError('restore preview ttl is invalid')
  }
  const expiresAt = currentTime + ttl
  const message = tokenMessage({
    ...restore,
    userId,
    sessionId,
    currentStateDigest,
    expiresAt
  })
  const mac = tokenMac(message, secret)
  return {
    token: `${TOKEN_VERSION}.${expiresAt}.${mac}`,
    expiresAt: new Date(expiresAt).toISOString()
  }
}

export function verifyDataRestorePreviewToken({
  token,
  restore,
  userId,
  sessionId,
  currentStateDigest,
  secret,
  now = Date.now()
}) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !/^\d+$/.test(parts[1])) {
    return { valid: false, reason: 'invalid' }
  }
  const expiresAt = Number(parts[1])
  const currentTime = boundedNow(now)
  if (
    !Number.isSafeInteger(expiresAt)
    || expiresAt <= currentTime
    || expiresAt > currentTime + DATA_RESTORE_PREVIEW_TTL_MS
  ) {
    return { valid: false, reason: expiresAt <= currentTime ? 'expired' : 'invalid' }
  }
  if (!/^[0-9a-f]{64}$/.test(parts[2])) {
    return { valid: false, reason: 'invalid' }
  }

  const expected = tokenMac(
    tokenMessage({
      ...restore,
      userId,
      sessionId,
      currentStateDigest,
      expiresAt
    }),
    secret
  )
  const receivedBuffer = Buffer.from(parts[2], 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return timingSafeEqual(receivedBuffer, expectedBuffer)
    ? { valid: true, reason: null, expiresAt: new Date(expiresAt).toISOString() }
    : { valid: false, reason: 'mismatch' }
}

export const DATA_RESTORE_LIMITS = Object.freeze({
  collections: COLLECTION_LIMITS,
  totalRecords: MAX_TOTAL_RECORDS,
  attachments: MAX_ATTACHMENTS,
  workUnits: MAX_RESTORE_WORK_UNITS
})
