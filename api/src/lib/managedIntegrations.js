import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { config } from '../config.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'

const DOCUMENT_VERSION = 1
const CONFIG_FILE_NAME = 'integrations.json'
const HOST_AGENT_MARKER = 'cloud-backup-agent.json'
const MAIL_UPDATE_MARKER = 'mail-update-in-progress.json'
const MANAGED_MAIL_PERSISTENCE_PATTERN = /^(?:integrations\.json|smtp-password|imap-password|email-encryption-key|mail-account-[a-f0-9]{24}-(?:smtp|imap)-password)$/
const MAX_SECONDARY_MAIL_ACCOUNTS = 1
const MAIL_ACCOUNT_ID_PATTERN = /^[a-f0-9]{24}$/
const MAIL_SOURCE_KEY_PATTERN = /^managed\.[a-f0-9]{24}$/
const SECRET_FILES = Object.freeze({
  smtpPassword: 'smtp-password',
  imapPassword: 'imap-password',
  emailEncryptionKey: 'email-encryption-key',
  s3AccessKeyId: 's3-access-key-id',
  s3SecretAccessKey: 's3-secret-access-key',
  s3SessionToken: 's3-session-token',
  resticPassword: 'restic-password'
})
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/
let mutationQueue = Promise.resolve()

export const MANAGED_MAIL_PERSISTENCE_ROLLBACK_FAILED = 'MANAGED_MAIL_PERSISTENCE_ROLLBACK_FAILED'
export const MANAGED_MAIL_UPDATE_IN_PROGRESS = 'MANAGED_MAIL_UPDATE_IN_PROGRESS'

export function withManagedIntegrationMutation(callback) {
  if (typeof callback !== 'function') throw new TypeError('集成配置操作无效')
  const operation = mutationQueue.then(callback, callback)
  mutationQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function emptyDocument() {
  return { version: DOCUMENT_VERSION, mail: null, mailAccounts: [], cloudBackup: null, updatedAt: null }
}

function integrationsDir(runtimeConfig = config) {
  const directory = String(runtimeConfig.managedIntegrationsDir || '').trim()
  if (!directory) throw new Error('服务器尚未启用可管理集成目录')
  if (!path.isAbsolute(directory)) throw new Error('可管理集成目录必须使用绝对路径')
  return path.resolve(directory)
}

function exactPath(name, runtimeConfig = config) {
  const fileName = String(name || '')
  if (!/^[a-z0-9.-]+$/.test(fileName)) throw new Error('集成文件名无效')
  return path.join(integrationsDir(runtimeConfig), fileName)
}

async function ensureDirectory(runtimeConfig = config) {
  const directory = integrationsDir(runtimeConfig)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('可管理集成目录必须是普通目录且不能是符号链接')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    await fs.chmod(directory, 0o700)
  }
  return directory
}

async function readManagedMailUpdateMarker(runtimeConfig = config) {
  const markerPath = exactPath(MAIL_UPDATE_MARKER, runtimeConfig)
  try {
    const stat = await fs.lstat(markerPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2048) {
      throw new Error('邮件配置更新标记不安全')
    }
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'))
    if (
      marker?.version !== 1
      || !/^[a-f0-9]{32}$/.test(String(marker?.token || ''))
      || !Number.isSafeInteger(marker?.pid)
      || typeof marker?.startedAt !== 'string'
    ) {
      throw new Error('邮件配置更新标记无效')
    }
    return marker
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    const blocked = new Error('邮件配置更新事务仍在进行或需要人工恢复')
    blocked.code = MANAGED_MAIL_UPDATE_IN_PROGRESS
    throw blocked
  }
}

export async function beginManagedMailUpdate(runtimeConfig = config, {
  openFn = fs.open,
  removeFn = fs.rm
} = {}) {
  const directory = await ensureDirectory(runtimeConfig)
  const markerPath = exactPath(MAIL_UPDATE_MARKER, runtimeConfig)
  const token = randomBytes(16).toString('hex')
  const marker = `${JSON.stringify({
    version: 1,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString()
  })}\n`
  let handle
  let markerCreated = false
  try {
    handle = await openFn(markerPath, 'wx', 0o600)
    markerCreated = true
    await handle.writeFile(marker, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = null
  } catch (error) {
    await handle?.close().catch(() => {})
    if (markerCreated) await removeFn(markerPath, { force: true }).catch(() => {})
    const blocked = new Error('邮件配置更新事务仍在进行或需要人工恢复')
    blocked.code = MANAGED_MAIL_UPDATE_IN_PROGRESS
    throw blocked
  }
  return { token, markerPath }
}

export async function assertManagedMailUpdateAvailable(
  runtimeConfig = config,
  { updateToken = null } = {}
) {
  const marker = await readManagedMailUpdateMarker(runtimeConfig)
  if (!marker) return true
  if (updateToken && marker.token === updateToken) return true
  const error = new Error('邮件配置更新事务仍在进行或需要人工恢复')
  error.code = MANAGED_MAIL_UPDATE_IN_PROGRESS
  throw error
}

export async function completeManagedMailUpdate(
  update,
  runtimeConfig = config
) {
  const token = String(update?.token || '')
  if (!/^[a-f0-9]{32}$/.test(token)) throw new TypeError('邮件配置更新令牌无效')
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken: token })
  await fs.rm(exactPath(MAIL_UPDATE_MARKER, runtimeConfig))
}

async function atomicWrite(filePath, content, mode = 0o600) {
  const directory = path.dirname(filePath)
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  const handle = await fs.open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.chmod(temporary, mode)
    await fs.rename(temporary, filePath)
    await fs.chmod(filePath, mode)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function boundedText(value, maximum, { required = false, label = '值' } = {}) {
  const normalized = String(value ?? '').normalize('NFKC').trim()
  if (CONTROL_PATTERN.test(normalized) || normalized.length > maximum || (required && !normalized)) {
    throw new TypeError(`${label}格式无效`)
  }
  return normalized
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  if (parsed < minimum || parsed > maximum) throw new TypeError(`${label}超出允许范围`)
  return parsed
}

function normalizeEmail(value, { required = false } = {}) {
  const email = boundedText(value, 320, { required, label: '邮箱地址' }).toLowerCase()
  if (email && !EMAIL_PATTERN.test(email)) throw new TypeError('邮箱地址格式无效')
  return email
}

function normalizeEmailList(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(',')
  return [...new Set(items.map((item) => normalizeEmail(item)).filter(Boolean))].slice(0, 20)
}

function normalizeHost(value, label) {
  const host = boundedText(value, 253, { label }).toLowerCase().replace(/\.$/, '')
  if (host && (!HOST_PATTERN.test(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) {
    throw new TypeError(`${label}格式无效`)
  }
  return host
}

function normalizeHours(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  const hours = [...new Set(values.map(Number).filter((hour) => Number.isSafeInteger(hour) && hour >= 0 && hour <= 23))]
  return (hours.length ? hours : [12, 20]).sort((left, right) => left - right)
}

function normalizeTimeZone(value) {
  const zone = boundedText(value || 'Asia/Shanghai', 80, { required: true, label: '时区' })
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: zone }).format(new Date())
  } catch {
    throw new TypeError('时区格式无效')
  }
  return zone
}

function normalizeEndpoint(value) {
  const raw = boundedText(value, 1000, { label: 'S3 Endpoint' })
  if (!raw) return ''
  let endpoint
  try { endpoint = new URL(raw) } catch { throw new TypeError('S3 Endpoint 格式无效') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('S3 Endpoint 必须是不含凭据、查询参数和片段的 HTTPS 地址')
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/'
  return endpoint.toString().replace(/\/$/, '')
}

function normalizePrefix(value) {
  const prefix = boundedText(value || 'nav', 240, { label: '备份前缀' })
    .replace(/^\/+|\/+$/g, '')
  if (!prefix || prefix.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('备份前缀格式无效')
  }
  return prefix
}

function normalizeSecret(value, label, maximum = 4096) {
  const secret = String(value ?? '').trim()
  if (!secret || secret.length > maximum || CONTROL_PATTERN.test(secret)) {
    throw new TypeError(`${label}格式无效`)
  }
  return secret
}

function mailDefaults(runtimeConfig = config) {
  return {
    deliveryEnabled: Boolean(runtimeConfig.mailDeliveryEnabled),
    registrationEnabled: Boolean(runtimeConfig.registrationEmailEnabled),
    ingestEnabled: Boolean(runtimeConfig.emailIngestEnabled),
    digestEnabled: Boolean(runtimeConfig.emailDigestEnabled),
    smtpHost: String(runtimeConfig.smtpHost || ''),
    smtpPort: Number(runtimeConfig.smtpPort || 465),
    smtpSecure: runtimeConfig.smtpSecure !== false,
    smtpUsername: String(runtimeConfig.smtpUsername || ''),
    smtpFromAddress: String(runtimeConfig.smtpFromAddress || ''),
    smtpFromName: String(runtimeConfig.smtpFromName || 'DOMO NAV'),
    adminRecipients: Array.isArray(runtimeConfig.adminEmailRecipients) ? runtimeConfig.adminEmailRecipients : [],
    ownerUsername: String(runtimeConfig.emailOwnerUsername || ''),
    imapHost: String(runtimeConfig.imapHost || ''),
    imapPort: Number(runtimeConfig.imapPort || 993),
    imapSecure: runtimeConfig.imapSecure !== false,
    imapUsername: String(runtimeConfig.imapUsername || ''),
    imapMailbox: String(runtimeConfig.imapMailbox || 'INBOX'),
    digestHours: Array.isArray(runtimeConfig.emailDigestHours) ? runtimeConfig.emailDigestHours : [12, 20],
    digestTimeZone: String(runtimeConfig.emailDigestTimeZone || 'Asia/Shanghai'),
    smtpVerifiedFingerprint: '',
    smtpVerifiedAt: null,
    imapVerifiedFingerprint: '',
    imapVerifiedAt: null
  }
}

export function normalizeManagedMailConfig(value = {}, fallback = mailDefaults()) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    deliveryEnabled: input.deliveryEnabled === true,
    registrationEnabled: input.registrationEnabled === true,
    ingestEnabled: input.ingestEnabled === true,
    digestEnabled: input.digestEnabled === true,
    smtpHost: normalizeHost(input.smtpHost ?? fallback.smtpHost, 'SMTP 主机'),
    smtpPort: boundedInteger(input.smtpPort, 465, 465, 465, 'SMTP 端口'),
    smtpSecure: true,
    smtpUsername: normalizeEmail(input.smtpUsername ?? fallback.smtpUsername),
    smtpFromAddress: normalizeEmail(input.smtpFromAddress ?? fallback.smtpFromAddress),
    smtpFromName: boundedText(input.smtpFromName ?? fallback.smtpFromName ?? 'DOMO NAV', 120, { required: true, label: '发件人名称' }),
    adminRecipients: normalizeEmailList(input.adminRecipients ?? fallback.adminRecipients),
    ownerUsername: boundedText(input.ownerUsername ?? fallback.ownerUsername, 128, { label: '邮件归属用户' }),
    imapHost: normalizeHost(input.imapHost ?? fallback.imapHost, 'IMAP 主机'),
    imapPort: boundedInteger(input.imapPort, 993, 993, 993, 'IMAP 端口'),
    imapSecure: true,
    imapUsername: normalizeEmail(input.imapUsername ?? fallback.imapUsername),
    imapMailbox: boundedText(input.imapMailbox ?? fallback.imapMailbox ?? 'INBOX', 255, { required: true, label: 'IMAP 邮箱目录' }),
    digestHours: normalizeHours(input.digestHours ?? fallback.digestHours),
    digestTimeZone: normalizeTimeZone(input.digestTimeZone ?? fallback.digestTimeZone),
    smtpVerifiedFingerprint: String(fallback.smtpVerifiedFingerprint || ''),
    smtpVerifiedAt: fallback.smtpVerifiedAt || null,
    imapVerifiedFingerprint: String(fallback.imapVerifiedFingerprint || ''),
    imapVerifiedAt: fallback.imapVerifiedAt || null
  }
}

function assertMailOwnerBindingUnchanged(previous, next) {
  if (String(previous?.ownerUsername || '') !== String(next?.ownerUsername || '')) {
    throw new TypeError('邮箱归属用户创建后不可修改；如需更换归属，请使用后续专用迁移流程')
  }
}

function normalizeMailAccountIdentity(value = {}, fallback = {}) {
  const id = String(value.id ?? fallback.id ?? '').trim().toLowerCase()
  const sourceKey = String(value.sourceKey ?? fallback.sourceKey ?? '').trim().toLowerCase()
  if (!MAIL_ACCOUNT_ID_PATTERN.test(id) || !MAIL_SOURCE_KEY_PATTERN.test(sourceKey) || sourceKey !== `managed.${id}`) {
    throw new TypeError('邮箱账号标识无效')
  }
  return {
    id,
    sourceKey,
    label: boundedText(value.label ?? fallback.label ?? '其他邮箱', 80, {
      required: true,
      label: '邮箱账号名称'
    })
  }
}

export function normalizeManagedMailAccount(value = {}, fallback = {}) {
  const identity = normalizeMailAccountIdentity(value, fallback)
  const normalized = normalizeManagedMailConfig(value, fallback)
  return {
    ...normalized,
    ...identity,
    // Registration mail and digest generation are installation-wide. A
    // secondary account is used only for user mail delivery and ingestion.
    registrationEnabled: false,
    digestEnabled: false,
    adminRecipients: []
  }
}

function cloudDefaults() {
  return {
    enabled: false,
    providerLabel: 'S3 Compatible',
    endpoint: '',
    bucket: '',
    region: 'auto',
    prefix: 'nav',
    addressingStyle: 'path',
    verifiedFingerprint: '',
    verifiedAt: null
  }
}

export function normalizeManagedCloudBackupConfig(value = {}, fallback = cloudDefaults()) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const bucket = boundedText(input.bucket ?? fallback.bucket, 63, { label: 'Bucket' })
  if (bucket && !BUCKET_PATTERN.test(bucket)) throw new TypeError('Bucket 名称格式无效')
  const addressingStyle = String(input.addressingStyle ?? fallback.addressingStyle) === 'virtual' ? 'virtual' : 'path'
  return {
    enabled: input.enabled === true,
    providerLabel: boundedText(input.providerLabel ?? fallback.providerLabel ?? 'S3 Compatible', 80, { required: true, label: '存储名称' }),
    endpoint: normalizeEndpoint(input.endpoint ?? fallback.endpoint),
    bucket,
    region: boundedText(input.region ?? fallback.region ?? 'auto', 64, { required: true, label: '区域' }),
    prefix: normalizePrefix(input.prefix ?? fallback.prefix ?? 'nav'),
    addressingStyle,
    verifiedFingerprint: String(fallback.verifiedFingerprint || ''),
    verifiedAt: fallback.verifiedAt || null
  }
}

async function readDocument(runtimeConfig = config) {
  if (!String(runtimeConfig.managedIntegrationsDir || '').trim()) return emptyDocument()
  const filePath = exactPath(CONFIG_FILE_NAME, runtimeConfig)
  let linkStat
  try { linkStat = await fs.lstat(filePath) } catch (error) {
    if (error?.code === 'ENOENT') return emptyDocument()
    throw error
  }
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > 128 * 1024) {
    throw new Error('集成配置文件不安全或过大')
  }
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!parsed || parsed.version !== DOCUMENT_VERSION || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('集成配置文件版本无效')
  }
  return {
    version: DOCUMENT_VERSION,
    mail: parsed.mail ? normalizeManagedMailConfig(parsed.mail, parsed.mail) : null,
    mailAccounts: Array.isArray(parsed.mailAccounts)
      ? parsed.mailAccounts.slice(0, MAX_SECONDARY_MAIL_ACCOUNTS)
        .map((account) => normalizeManagedMailAccount(account, account))
      : [],
    cloudBackup: parsed.cloudBackup
      ? normalizeManagedCloudBackupConfig(parsed.cloudBackup, parsed.cloudBackup)
      : null,
    updatedAt: parsed.updatedAt || null
  }
}

async function writeDocument(document, runtimeConfig = config) {
  await ensureDirectory(runtimeConfig)
  const payload = {
    version: DOCUMENT_VERSION,
    mail: document.mail || null,
    mailAccounts: Array.isArray(document.mailAccounts)
      ? document.mailAccounts.slice(0, MAX_SECONDARY_MAIL_ACCOUNTS)
      : [],
    cloudBackup: document.cloudBackup || null,
    updatedAt: new Date().toISOString()
  }
  await atomicWrite(exactPath(CONFIG_FILE_NAME, runtimeConfig), `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function safePersistenceErrorCode(error, fallback) {
  const code = String(error?.code || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback
}

export async function snapshotManagedMailPersistence(runtimeConfig = config) {
  const directory = await ensureDirectory(runtimeConfig)
  const names = (await fs.readdir(directory))
    .filter((name) => MANAGED_MAIL_PERSISTENCE_PATTERN.test(name))
    .sort()
  const files = []
  for (const name of names) {
    const filePath = exactPath(name, runtimeConfig)
    const stat = await fs.lstat(filePath)
    const maximum = name === CONFIG_FILE_NAME ? 128 * 1024 : 4096
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
      throw new Error('邮件集成持久化文件不安全或过大')
    }
    files.push({
      name,
      content: await fs.readFile(filePath, 'utf8'),
      mode: process.platform === 'win32' ? 0o600 : stat.mode & 0o777
    })
  }
  return { files }
}

export async function restoreManagedMailPersistence(snapshot, runtimeConfig = config) {
  const directory = await ensureDirectory(runtimeConfig)
  const expected = new Map((snapshot?.files || []).map((file) => [file.name, file]))
  const failures = []
  const currentNames = (await fs.readdir(directory))
    .filter((name) => MANAGED_MAIL_PERSISTENCE_PATTERN.test(name))
  for (const name of currentNames) {
    if (expected.has(name)) continue
    try { await fs.rm(exactPath(name, runtimeConfig), { force: true }) } catch (error) { failures.push(error) }
  }
  const ordered = [...expected.values()].sort((left, right) => (
    left.name === CONFIG_FILE_NAME ? 1 : right.name === CONFIG_FILE_NAME ? -1 : left.name.localeCompare(right.name)
  ))
  for (const file of ordered) {
    try {
      await atomicWrite(exactPath(file.name, runtimeConfig), file.content, file.mode || 0o600)
    } catch (error) {
      failures.push(error)
    }
  }
  if (!expected.has(CONFIG_FILE_NAME)) {
    try { await fs.rm(exactPath(CONFIG_FILE_NAME, runtimeConfig), { force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length) {
    const error = new Error('邮件集成持久化回滚未完成')
    error.code = MANAGED_MAIL_PERSISTENCE_ROLLBACK_FAILED
    error.rollbackErrorCode = safePersistenceErrorCode(failures[0], 'PERSISTENCE_RESTORE_FAILED')
    throw error
  }
}

async function restorePersistenceOrThrow(snapshot, originalError, runtimeConfig, restoreFn) {
  try {
    await restoreFn(snapshot, runtimeConfig)
  } catch (rollbackError) {
    const error = new Error('邮件集成保存失败且持久化回滚未完成；邮件运行时必须保持关闭')
    error.code = MANAGED_MAIL_PERSISTENCE_ROLLBACK_FAILED
    error.writeErrorCode = safePersistenceErrorCode(originalError, 'MAIL_INTEGRATION_WRITE_FAILED')
    error.rollbackErrorCode = safePersistenceErrorCode(rollbackError, 'PERSISTENCE_RESTORE_FAILED')
    throw error
  }
  throw originalError
}

async function secretConfigured(secretName, runtimeConfig = config) {
  try {
    await readOwnerSecretFile(exactPath(SECRET_FILES[secretName], runtimeConfig), {
      label: secretName,
      maxBytes: 4096
    })
    return true
  } catch {
    return false
  }
}

async function readSecret(secretName, runtimeConfig = config) {
  return readOwnerSecretFile(exactPath(SECRET_FILES[secretName], runtimeConfig), {
    label: secretName,
    maxBytes: 4096
  })
}

async function writeSecret(secretName, value, label, runtimeConfig = config) {
  await ensureDirectory(runtimeConfig)
  const normalized = normalizeSecret(value, label)
  await atomicWrite(exactPath(SECRET_FILES[secretName], runtimeConfig), `${normalized}\n`)
}

async function removeSecret(secretName, runtimeConfig = config) {
  await fs.rm(exactPath(SECRET_FILES[secretName], runtimeConfig), { force: true })
}

function secondaryMailSecretFile(kind, accountId) {
  const id = String(accountId || '').trim().toLowerCase()
  if (!MAIL_ACCOUNT_ID_PATTERN.test(id) || !['smtpPassword', 'imapPassword'].includes(kind)) {
    throw new TypeError('邮箱账号密钥标识无效')
  }
  const suffix = kind === 'smtpPassword' ? 'smtp-password' : 'imap-password'
  return `mail-account-${id}-${suffix}`
}

async function secondaryMailSecretConfigured(kind, accountId, runtimeConfig = config) {
  try {
    await readOwnerSecretFile(exactPath(secondaryMailSecretFile(kind, accountId), runtimeConfig), {
      label: kind,
      maxBytes: 4096
    })
    return true
  } catch {
    return false
  }
}

async function readSecondaryMailSecret(kind, accountId, runtimeConfig = config) {
  return readOwnerSecretFile(exactPath(secondaryMailSecretFile(kind, accountId), runtimeConfig), {
    label: kind,
    maxBytes: 4096
  })
}

async function writeSecondaryMailSecret(kind, accountId, value, label, runtimeConfig = config) {
  await ensureDirectory(runtimeConfig)
  await atomicWrite(
    exactPath(secondaryMailSecretFile(kind, accountId), runtimeConfig),
    `${normalizeSecret(value, label)}\n`
  )
}

async function removeSecondaryMailSecret(kind, accountId, runtimeConfig = config) {
  await fs.rm(exactPath(secondaryMailSecretFile(kind, accountId), runtimeConfig), { force: true })
}

function fingerprint(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function smtpFingerprintForSecret(mail, secret) {
  if (!secret) return ''
  return fingerprint([
    'smtp-v1', mail.smtpHost, mail.smtpPort, mail.smtpUsername,
    mail.smtpFromAddress, secret
  ])
}

async function smtpFingerprint(mail, runtimeConfig = config) {
  return smtpFingerprintForSecret(mail, await readSecret('smtpPassword', runtimeConfig))
}

function imapFingerprintForSecret(mail, secret) {
  if (!secret) return ''
  return fingerprint([
    'imap-v1', mail.ownerUsername, mail.imapHost, mail.imapPort,
    mail.imapUsername, mail.imapMailbox, secret
  ])
}

async function imapFingerprint(mail, runtimeConfig = config) {
  return imapFingerprintForSecret(mail, await readSecret('imapPassword', runtimeConfig))
}

async function secondaryMailFingerprint(kind, mail, runtimeConfig = config) {
  const secret = await readSecondaryMailSecret(
    kind === 'smtp' ? 'smtpPassword' : 'imapPassword',
    mail.id,
    runtimeConfig
  )
  return kind === 'smtp'
    ? smtpFingerprintForSecret(mail, secret)
    : imapFingerprintForSecret(mail, secret)
}

function cloudFingerprintForSecrets(cloud, accessKeyId, secretAccessKey, sessionToken = '') {
  if (!accessKeyId || !secretAccessKey) return ''
  return fingerprint([
    's3-v1', cloud.endpoint, cloud.bucket, cloud.region, cloud.prefix,
    cloud.addressingStyle, accessKeyId, secretAccessKey, sessionToken
  ])
}

async function cloudFingerprint(cloud, runtimeConfig = config) {
  return cloudFingerprintForSecrets(
    cloud,
    await readSecret('s3AccessKeyId', runtimeConfig),
    await readSecret('s3SecretAccessKey', runtimeConfig),
    await readSecret('s3SessionToken', runtimeConfig).catch(() => '')
  )
}

async function hasCurrentVerification(kind, integration, runtimeConfig = config) {
  try {
    if (kind === 'smtp') return integration.smtpVerifiedFingerprint === await smtpFingerprint(integration, runtimeConfig)
    if (kind === 'imap') return integration.imapVerifiedFingerprint === await imapFingerprint(integration, runtimeConfig)
    return integration.verifiedFingerprint === await cloudFingerprint(integration, runtimeConfig)
  } catch {
    return false
  }
}

async function hasCurrentSecondaryMailVerification(kind, integration, runtimeConfig = config) {
  try {
    const actual = await secondaryMailFingerprint(kind, integration, runtimeConfig)
    return kind === 'smtp'
      ? integration.smtpVerifiedFingerprint === actual
      : integration.imapVerifiedFingerprint === actual
  } catch {
    return false
  }
}

function validateMailActivation(mail, verification) {
  if (mail.deliveryEnabled) {
    if (!mail.smtpHost || !mail.smtpUsername || !mail.smtpFromAddress || !verification.smtp) {
      throw new TypeError('启用邮件发送前，请完整填写 SMTP 配置并通过连接测试')
    }
  }
  if (mail.registrationEnabled && !mail.deliveryEnabled) {
    throw new TypeError('注册邮箱验证依赖邮件发送，请先启用邮件发送')
  }
  if (mail.ingestEnabled) {
    if (!mail.ownerUsername || !mail.imapHost || !mail.imapUsername || !verification.imap) {
      throw new TypeError('启用智能收件前，请完整填写 IMAP 配置并通过连接测试')
    }
  }
  if (mail.digestEnabled && !mail.ingestEnabled) {
    throw new TypeError('邮件摘要依赖智能收件，请先启用智能收件')
  }
}

async function ensureEmailEncryptionKey(runtimeConfig = config) {
  if (await secretConfigured('emailEncryptionKey', runtimeConfig)) return
  await writeSecret(
    'emailEncryptionKey',
    randomBytes(32).toString('base64'),
    '邮件加密密钥',
    runtimeConfig
  )
}

export function managedIntegrationsAvailable(runtimeConfig = config) {
  try { integrationsDir(runtimeConfig); return true } catch { return false }
}

async function managedIntegrationsWritable(runtimeConfig = config) {
  if (!managedIntegrationsAvailable(runtimeConfig)) return false
  try {
    const directory = integrationsDir(runtimeConfig)
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

const MANAGED_MAIL_RUNTIME_KEYS = Object.freeze([
  'mailDeliveryEnabled',
  'registrationEmailEnabled',
  'emailIngestEnabled',
  'emailDigestEnabled',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUsername',
  'smtpPasswordFile',
  'smtpFromAddress',
  'smtpFromName',
  'adminEmailRecipients',
  'emailOwnerUsername',
  'emailEncryptionKeyFile',
  'imapHost',
  'imapPort',
  'imapSecure',
  'imapUsername',
  'imapPasswordFile',
  'imapMailbox',
  'emailDigestHours',
  'emailDigestTimeZone',
  'emailPrimaryAccount',
  'emailAccountLabel'
])

export function snapshotManagedMailRuntimeConfig(runtimeConfig = config) {
  return Object.fromEntries(MANAGED_MAIL_RUNTIME_KEYS.map((key) => [
    key,
    Array.isArray(runtimeConfig[key]) ? [...runtimeConfig[key]] : runtimeConfig[key]
  ]))
}

export function restoreManagedMailRuntimeConfig(snapshot, runtimeConfig = config) {
  for (const key of MANAGED_MAIL_RUNTIME_KEYS) {
    const value = snapshot?.[key]
    runtimeConfig[key] = Array.isArray(value) ? [...value] : value
  }
  return runtimeConfig
}

export async function applyManagedIntegrationsToRuntime(
  runtimeConfig = config,
  { updateToken = null } = {}
) {
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  const document = await readDocument(runtimeConfig)
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  if (!document.mail) return { source: 'environment', document }
  const mail = document.mail
  Object.assign(runtimeConfig, {
    mailDeliveryEnabled: mail.deliveryEnabled,
    registrationEmailEnabled: mail.registrationEnabled,
    emailIngestEnabled: mail.ingestEnabled,
    emailDigestEnabled: mail.digestEnabled,
    smtpHost: mail.smtpHost,
    smtpPort: mail.smtpPort,
    smtpSecure: true,
    smtpUsername: mail.smtpUsername,
    smtpPasswordFile: exactPath(SECRET_FILES.smtpPassword, runtimeConfig),
    smtpFromAddress: mail.smtpFromAddress,
    smtpFromName: mail.smtpFromName,
    adminEmailRecipients: mail.adminRecipients,
    emailOwnerUsername: mail.ownerUsername,
    emailEncryptionKeyFile: exactPath(SECRET_FILES.emailEncryptionKey, runtimeConfig),
    imapHost: mail.imapHost,
    imapPort: mail.imapPort,
    imapSecure: true,
    imapUsername: mail.imapUsername,
    imapPasswordFile: exactPath(SECRET_FILES.imapPassword, runtimeConfig),
    imapMailbox: mail.imapMailbox,
    emailDigestHours: mail.digestHours,
    emailDigestTimeZone: mail.digestTimeZone,
    emailPrimaryAccount: true,
    emailAccountLabel: '个人邮箱'
  })
  return { source: 'managed', document }
}

function publicMailConfig(mail) {
  return {
    deliveryEnabled: mail.deliveryEnabled,
    registrationEnabled: mail.registrationEnabled,
    ingestEnabled: mail.ingestEnabled,
    digestEnabled: mail.digestEnabled,
    smtpHost: mail.smtpHost,
    smtpPort: mail.smtpPort,
    smtpSecure: true,
    smtpUsername: mail.smtpUsername,
    smtpFromAddress: mail.smtpFromAddress,
    smtpFromName: mail.smtpFromName,
    adminRecipients: mail.adminRecipients,
    ownerUsername: mail.ownerUsername,
    imapHost: mail.imapHost,
    imapPort: mail.imapPort,
    imapSecure: true,
    imapUsername: mail.imapUsername,
    imapMailbox: mail.imapMailbox,
    digestHours: mail.digestHours,
    digestTimeZone: mail.digestTimeZone
  }
}

async function mailPublicState(document, runtimeConfig = config) {
  const mail = document.mail || normalizeManagedMailConfig({}, mailDefaults(runtimeConfig))
  const [smtpPasswordConfigured, imapPasswordConfigured, encryptionConfigured, smtpVerified, imapVerified] = await Promise.all([
    secretConfigured('smtpPassword', runtimeConfig),
    secretConfigured('imapPassword', runtimeConfig),
    secretConfigured('emailEncryptionKey', runtimeConfig),
    hasCurrentVerification('smtp', mail, runtimeConfig),
    hasCurrentVerification('imap', mail, runtimeConfig)
  ])
  return {
    config: publicMailConfig(mail),
    secrets: { smtpPasswordConfigured, imapPasswordConfigured, encryptionConfigured },
    verification: {
      smtpVerified,
      smtpVerifiedAt: smtpVerified ? mail.smtpVerifiedAt : null,
      imapVerified,
      imapVerifiedAt: imapVerified ? mail.imapVerifiedAt : null
    }
  }
}

async function secondaryMailPublicState(mail, runtimeConfig = config) {
  const [smtpPasswordConfigured, imapPasswordConfigured, encryptionConfigured, smtpVerified, imapVerified] = await Promise.all([
    secondaryMailSecretConfigured('smtpPassword', mail.id, runtimeConfig),
    secondaryMailSecretConfigured('imapPassword', mail.id, runtimeConfig),
    secretConfigured('emailEncryptionKey', runtimeConfig),
    hasCurrentSecondaryMailVerification('smtp', mail, runtimeConfig),
    hasCurrentSecondaryMailVerification('imap', mail, runtimeConfig)
  ])
  return {
    id: mail.id,
    sourceKey: mail.sourceKey,
    label: mail.label,
    config: publicMailConfig(mail),
    secrets: { smtpPasswordConfigured, imapPasswordConfigured, encryptionConfigured },
    verification: {
      smtpVerified,
      smtpVerifiedAt: smtpVerified ? mail.smtpVerifiedAt : null,
      imapVerified,
      imapVerifiedAt: imapVerified ? mail.imapVerifiedAt : null
    }
  }
}

async function cloudPublicState(document, runtimeConfig = config) {
  const cloud = document.cloudBackup || normalizeManagedCloudBackupConfig({}, cloudDefaults())
  const [accessKeyConfigured, secretKeyConfigured, sessionTokenConfigured, resticPasswordConfigured, verified] = await Promise.all([
    secretConfigured('s3AccessKeyId', runtimeConfig),
    secretConfigured('s3SecretAccessKey', runtimeConfig),
    secretConfigured('s3SessionToken', runtimeConfig),
    secretConfigured('resticPassword', runtimeConfig),
    hasCurrentVerification('cloud', cloud, runtimeConfig)
  ])
  let hostAgent = null
  try {
    const parsed = JSON.parse(await fs.readFile(exactPath(HOST_AGENT_MARKER, runtimeConfig), 'utf8'))
    hostAgent = {
      installed: parsed?.installed === true,
      timerEnabled: parsed?.timerEnabled === true,
      updatedAt: parsed?.updatedAt || null
    }
  } catch {
    hostAgent = { installed: false, timerEnabled: false, updatedAt: null }
  }
  return {
    config: {
      enabled: cloud.enabled,
      providerLabel: cloud.providerLabel,
      endpoint: cloud.endpoint,
      bucket: cloud.bucket,
      region: cloud.region,
      prefix: cloud.prefix,
      addressingStyle: cloud.addressingStyle
    },
    secrets: { accessKeyConfigured, secretKeyConfigured, sessionTokenConfigured, resticPasswordConfigured },
    verification: { verified, verifiedAt: verified ? cloud.verifiedAt : null },
    hostAgent
  }
}

export async function getManagedIntegrationsState(runtimeConfig = config) {
  const writable = await managedIntegrationsWritable(runtimeConfig)
  const document = writable ? await readDocument(runtimeConfig) : emptyDocument()
  return {
    writable,
    source: document.mail || document.cloudBackup ? 'managed' : 'environment',
    mailPrimaryManaged: Boolean(document.mail),
    mail: await mailPublicState(document, runtimeConfig),
    mailAccounts: await Promise.all((document.mailAccounts || []).map(
      (mail) => secondaryMailPublicState(mail, runtimeConfig)
    )),
    mailAccountLimit: 1 + MAX_SECONDARY_MAIL_ACCOUNTS,
    cloudBackup: await cloudPublicState(document, runtimeConfig),
    updatedAt: document.updatedAt
  }
}

export async function saveManagedMailConfig(input = {}, runtimeConfig = config, {
  writeDocumentFn = writeDocument,
  restorePersistenceFn = restoreManagedMailPersistence,
  updateToken = null
} = {}) {
  await ensureDirectory(runtimeConfig)
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  const document = await readDocument(runtimeConfig)
  const previous = document.mail || normalizeManagedMailConfig({}, mailDefaults(runtimeConfig))
  const next = normalizeManagedMailConfig(input, previous)
  if (document.mail) assertMailOwnerBindingUnchanged(previous, next)
  const currentSmtpPassword = await readSecret('smtpPassword', runtimeConfig).catch(() => '')
  const currentImapPassword = await readSecret('imapPassword', runtimeConfig).catch(() => '')
  const nextSmtpPassword = input.clearSmtpPassword === true
    ? ''
    : input.smtpPassword
      ? normalizeSecret(input.smtpPassword, 'SMTP 密码')
      : currentSmtpPassword
  const nextImapPassword = input.clearImapPassword === true
    ? ''
    : input.reuseSmtpPasswordForImap === true
      ? nextSmtpPassword
      : input.imapPassword
        ? normalizeSecret(input.imapPassword, 'IMAP 密码')
        : currentImapPassword

  const verification = {
    smtp: Boolean(
      next.smtpVerifiedFingerprint
      && next.smtpVerifiedFingerprint === smtpFingerprintForSecret(next, nextSmtpPassword)
    ),
    imap: Boolean(
      next.imapVerifiedFingerprint
      && next.imapVerifiedFingerprint === imapFingerprintForSecret(next, nextImapPassword)
    )
  }
  if (!verification.smtp) {
    next.smtpVerifiedFingerprint = ''
    next.smtpVerifiedAt = null
  }
  if (!verification.imap) {
    next.imapVerifiedFingerprint = ''
    next.imapVerifiedAt = null
  }
  validateMailActivation(next, verification)

  const persistenceSnapshot = await snapshotManagedMailPersistence(runtimeConfig)
  try {
    if (nextSmtpPassword && nextSmtpPassword !== currentSmtpPassword) {
      await writeSecret('smtpPassword', nextSmtpPassword, 'SMTP 密码', runtimeConfig)
    } else if (!nextSmtpPassword && currentSmtpPassword) {
      await removeSecret('smtpPassword', runtimeConfig)
    }
    if (nextImapPassword && nextImapPassword !== currentImapPassword) {
      await writeSecret('imapPassword', nextImapPassword, 'IMAP 密码', runtimeConfig)
    } else if (!nextImapPassword && currentImapPassword) {
      await removeSecret('imapPassword', runtimeConfig)
    }
    await ensureEmailEncryptionKey(runtimeConfig)
    document.mail = next
    const written = await writeDocumentFn(document, runtimeConfig)
    return mailPublicState(written, runtimeConfig)
  } catch (error) {
    return restorePersistenceOrThrow(persistenceSnapshot, error, runtimeConfig, restorePersistenceFn)
  }
}

export async function markManagedMailVerified(kind, runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  if (!document.mail) throw new Error('请先保存邮件配置')
  const now = new Date().toISOString()
  if (kind === 'smtp') {
    document.mail.smtpVerifiedFingerprint = await smtpFingerprint(document.mail, runtimeConfig)
    document.mail.smtpVerifiedAt = now
  } else if (kind === 'imap') {
    document.mail.imapVerifiedFingerprint = await imapFingerprint(document.mail, runtimeConfig)
    document.mail.imapVerifiedAt = now
  } else throw new TypeError('邮件验证类型无效')
  const written = await writeDocument(document, runtimeConfig)
  return mailPublicState(written, runtimeConfig)
}

function findSecondaryMailAccount(document, accountId) {
  const id = String(accountId || '').trim().toLowerCase()
  if (!MAIL_ACCOUNT_ID_PATTERN.test(id)) throw new TypeError('邮箱账号标识无效')
  const index = (document.mailAccounts || []).findIndex((account) => account.id === id)
  if (index < 0) throw new Error('邮箱账号不存在')
  return { account: document.mailAccounts[index], index }
}

async function saveSecondaryMailSecrets(accountId, input, current, runtimeConfig = config) {
  const currentSmtpPassword = await readSecondaryMailSecret('smtpPassword', accountId, runtimeConfig).catch(() => '')
  const currentImapPassword = await readSecondaryMailSecret('imapPassword', accountId, runtimeConfig).catch(() => '')
  const nextSmtpPassword = input.clearSmtpPassword === true
    ? ''
    : input.smtpPassword
      ? normalizeSecret(input.smtpPassword, 'SMTP 密码')
      : currentSmtpPassword
  const nextImapPassword = input.clearImapPassword === true
    ? ''
    : input.reuseSmtpPasswordForImap === true
      ? nextSmtpPassword
      : input.imapPassword
        ? normalizeSecret(input.imapPassword, 'IMAP 密码')
        : currentImapPassword
  const verification = {
    smtp: Boolean(
      current.smtpVerifiedFingerprint
      && current.smtpVerifiedFingerprint === smtpFingerprintForSecret(current, nextSmtpPassword)
    ),
    imap: Boolean(
      current.imapVerifiedFingerprint
      && current.imapVerifiedFingerprint === imapFingerprintForSecret(current, nextImapPassword)
    )
  }
  if (!verification.smtp) {
    current.smtpVerifiedFingerprint = ''
    current.smtpVerifiedAt = null
  }
  if (!verification.imap) {
    current.imapVerifiedFingerprint = ''
    current.imapVerifiedAt = null
  }
  validateMailActivation(current, verification)
  if (nextSmtpPassword && nextSmtpPassword !== currentSmtpPassword) {
    await writeSecondaryMailSecret('smtpPassword', accountId, nextSmtpPassword, 'SMTP 密码', runtimeConfig)
  } else if (!nextSmtpPassword && currentSmtpPassword) {
    await removeSecondaryMailSecret('smtpPassword', accountId, runtimeConfig)
  }
  if (nextImapPassword && nextImapPassword !== currentImapPassword) {
    await writeSecondaryMailSecret('imapPassword', accountId, nextImapPassword, 'IMAP 密码', runtimeConfig)
  } else if (!nextImapPassword && currentImapPassword) {
    await removeSecondaryMailSecret('imapPassword', accountId, runtimeConfig)
  }
}

export async function createManagedMailAccount(input = {}, runtimeConfig = config, {
  writeDocumentFn = writeDocument,
  restorePersistenceFn = restoreManagedMailPersistence,
  updateToken = null
} = {}) {
  await ensureDirectory(runtimeConfig)
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  const document = await readDocument(runtimeConfig)
  if (!document.mail) throw new TypeError('请先保存主邮箱配置')
  if ((document.mailAccounts || []).length >= MAX_SECONDARY_MAIL_ACCOUNTS) {
    throw new TypeError('目前最多支持两个邮箱账号')
  }
  const id = randomBytes(12).toString('hex')
  const fallback = {
    ...normalizeManagedMailConfig({}, mailDefaults(runtimeConfig)),
    id,
    sourceKey: `managed.${id}`,
    label: '其他邮箱'
  }
  const next = normalizeManagedMailAccount({
    ...input,
    id,
    sourceKey: `managed.${id}`
  }, fallback)
  const persistenceSnapshot = await snapshotManagedMailPersistence(runtimeConfig)
  try {
    await saveSecondaryMailSecrets(id, input, next, runtimeConfig)
    await ensureEmailEncryptionKey(runtimeConfig)
    document.mailAccounts = [...(document.mailAccounts || []), next]
    const written = await writeDocumentFn(document, runtimeConfig)
    return secondaryMailPublicState(written.mailAccounts.at(-1), runtimeConfig)
  } catch (error) {
    return restorePersistenceOrThrow(persistenceSnapshot, error, runtimeConfig, restorePersistenceFn)
  }
}

export async function saveManagedMailAccount(accountId, input = {}, runtimeConfig = config, {
  writeDocumentFn = writeDocument,
  restorePersistenceFn = restoreManagedMailPersistence,
  updateToken = null
} = {}) {
  await ensureDirectory(runtimeConfig)
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  const document = await readDocument(runtimeConfig)
  const { account: previous, index } = findSecondaryMailAccount(document, accountId)
  const next = normalizeManagedMailAccount({
    ...input,
    id: previous.id,
    sourceKey: previous.sourceKey
  }, previous)
  assertMailOwnerBindingUnchanged(previous, next)
  const persistenceSnapshot = await snapshotManagedMailPersistence(runtimeConfig)
  try {
    await saveSecondaryMailSecrets(previous.id, input, next, runtimeConfig)
    await ensureEmailEncryptionKey(runtimeConfig)
    document.mailAccounts[index] = next
    const written = await writeDocumentFn(document, runtimeConfig)
    return secondaryMailPublicState(written.mailAccounts[index], runtimeConfig)
  } catch (error) {
    return restorePersistenceOrThrow(persistenceSnapshot, error, runtimeConfig, restorePersistenceFn)
  }
}

export async function markManagedMailAccountVerified(kind, accountId, runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  const { account, index } = findSecondaryMailAccount(document, accountId)
  const now = new Date().toISOString()
  if (kind === 'smtp') {
    account.smtpVerifiedFingerprint = await secondaryMailFingerprint('smtp', account, runtimeConfig)
    account.smtpVerifiedAt = now
  } else if (kind === 'imap') {
    account.imapVerifiedFingerprint = await secondaryMailFingerprint('imap', account, runtimeConfig)
    account.imapVerifiedAt = now
  } else throw new TypeError('邮件验证类型无效')
  document.mailAccounts[index] = account
  const written = await writeDocument(document, runtimeConfig)
  return secondaryMailPublicState(written.mailAccounts[index], runtimeConfig)
}

function runtimeMailConfig(mail, runtimeConfig, { primary }) {
  const smtpPasswordFile = primary
    ? exactPath(SECRET_FILES.smtpPassword, runtimeConfig)
    : exactPath(secondaryMailSecretFile('smtpPassword', mail.id), runtimeConfig)
  const imapPasswordFile = primary
    ? exactPath(SECRET_FILES.imapPassword, runtimeConfig)
    : exactPath(secondaryMailSecretFile('imapPassword', mail.id), runtimeConfig)
  return {
    ...runtimeConfig,
    // OAuth credentials are currently managed only for the primary mailbox.
    // Never let a secondary password-backed account inherit the primary
    // refresh-token provider through the shared process configuration.
    smtpOauthProvider: primary ? String(runtimeConfig.smtpOauthProvider || '') : '',
    imapOauthProvider: primary ? String(runtimeConfig.imapOauthProvider || '') : '',
    mailDeliveryEnabled: mail.deliveryEnabled,
    registrationEmailEnabled: primary && mail.registrationEnabled,
    emailIngestEnabled: mail.ingestEnabled,
    emailSentAppendEnabled: mail.ingestEnabled && runtimeConfig.emailSentAppendEnabled === true,
    emailDigestEnabled: primary && mail.digestEnabled,
    smtpHost: mail.smtpHost,
    smtpPort: mail.smtpPort,
    smtpSecure: true,
    smtpUsername: mail.smtpUsername,
    smtpPasswordFile,
    smtpFromAddress: mail.smtpFromAddress,
    smtpFromName: mail.smtpFromName,
    adminEmailRecipients: primary ? mail.adminRecipients : [],
    emailOwnerUsername: mail.ownerUsername,
    emailEncryptionKeyFile: exactPath(SECRET_FILES.emailEncryptionKey, runtimeConfig),
    emailSourceKey: primary ? String(runtimeConfig.emailSourceKey || 'mxroute').trim().toLowerCase() : mail.sourceKey,
    emailAccountLabel: primary ? '个人邮箱' : mail.label,
    emailPrimaryAccount: primary,
    emailManagedAccount: true,
    emailManagedAccountId: primary ? null : mail.id,
    imapHost: mail.imapHost,
    imapPort: mail.imapPort,
    imapSecure: true,
    imapUsername: mail.imapUsername,
    imapPasswordFile,
    imapMailbox: mail.imapMailbox,
    emailDigestHours: mail.digestHours,
    emailDigestTimeZone: mail.digestTimeZone
  }
}

export async function managedMailAccountTestConfig(accountId, runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  const { account } = findSecondaryMailAccount(document, accountId)
  return runtimeMailConfig(account, runtimeConfig, { primary: false })
}

function resticRepository(cloud) {
  const endpoint = cloud.endpoint.replace(/\/+$/, '')
  const bucket = encodeURIComponent(cloud.bucket)
  const prefix = cloud.prefix.split('/').map(encodeURIComponent).join('/')
  if (cloud.addressingStyle === 'virtual') {
    const url = new URL(endpoint)
    url.hostname = `${cloud.bucket}.${url.hostname}`
    return `s3:${url.toString().replace(/\/$/, '')}/${prefix}`
  }
  return `s3:${endpoint}/${bucket}/${prefix}`
}

async function writeCloudEnvironment(cloud, runtimeConfig = config) {
  const directory = integrationsDir(runtimeConfig)
  const accessKeyId = await readSecret('s3AccessKeyId', runtimeConfig)
  const secretAccessKey = await readSecret('s3SecretAccessKey', runtimeConfig)
  const sessionToken = await readSecret('s3SessionToken', runtimeConfig).catch(() => '')
  const resticLines = [
    `RESTIC_REPOSITORY=${resticRepository(cloud)}`,
    `RESTIC_PASSWORD_FILE=${path.join(directory, SECRET_FILES.resticPassword)}`,
    `AWS_ACCESS_KEY_ID=${accessKeyId}`,
    `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
    `AWS_DEFAULT_REGION=${cloud.region}`
  ]
  if (sessionToken) resticLines.push(`AWS_SESSION_TOKEN=${sessionToken}`)
  await atomicWrite(exactPath('restic-offsite.env', runtimeConfig), `${resticLines.join('\n')}\n`)
  await atomicWrite(exactPath('cloud-backup.env', runtimeConfig), [
    `NAV_ENABLE_CLOUD_UPLOAD=${cloud.enabled ? 'true' : 'false'}`,
    `NAV_RESTIC_ENV_FILE=${path.join(directory, 'restic-offsite.env')}`,
    'NAV_RESTIC_RUN_CHECK=true'
  ].join('\n') + '\n')
}

export async function saveManagedCloudBackupConfig(input = {}, runtimeConfig = config) {
  await ensureDirectory(runtimeConfig)
  const document = await readDocument(runtimeConfig)
  const previous = document.cloudBackup || normalizeManagedCloudBackupConfig({}, cloudDefaults())
  const next = normalizeManagedCloudBackupConfig(input, previous)
  const currentAccessKeyId = await readSecret('s3AccessKeyId', runtimeConfig).catch(() => '')
  const currentSecretAccessKey = await readSecret('s3SecretAccessKey', runtimeConfig).catch(() => '')
  const currentSessionToken = await readSecret('s3SessionToken', runtimeConfig).catch(() => '')
  const nextAccessKeyId = input.accessKeyId
    ? normalizeSecret(input.accessKeyId, 'S3 Access Key ID')
    : currentAccessKeyId
  const nextSecretAccessKey = input.secretAccessKey
    ? normalizeSecret(input.secretAccessKey, 'S3 Secret Access Key')
    : currentSecretAccessKey
  const nextSessionToken = input.clearSessionToken === true
    ? ''
    : input.sessionToken
      ? normalizeSecret(input.sessionToken, 'S3 Session Token')
      : currentSessionToken
  const verified = Boolean(
    next.verifiedFingerprint
    && next.verifiedFingerprint === cloudFingerprintForSecrets(
      next,
      nextAccessKeyId,
      nextSecretAccessKey,
      nextSessionToken
    )
  )
  if (!verified) {
    next.verifiedFingerprint = ''
    next.verifiedAt = null
  }
  if (next.enabled && (!next.endpoint || !next.bucket || !verified)) {
    throw new TypeError('启用云备份前，请完整填写对象存储配置并通过只读连接测试')
  }
  if (nextAccessKeyId && nextAccessKeyId !== currentAccessKeyId) {
    await writeSecret('s3AccessKeyId', nextAccessKeyId, 'S3 Access Key ID', runtimeConfig)
  }
  if (nextSecretAccessKey && nextSecretAccessKey !== currentSecretAccessKey) {
    await writeSecret('s3SecretAccessKey', nextSecretAccessKey, 'S3 Secret Access Key', runtimeConfig)
  }
  if (nextSessionToken && nextSessionToken !== currentSessionToken) {
    await writeSecret('s3SessionToken', nextSessionToken, 'S3 Session Token', runtimeConfig)
  } else if (!nextSessionToken && currentSessionToken) {
    await removeSecret('s3SessionToken', runtimeConfig)
  }
  if (!await secretConfigured('resticPassword', runtimeConfig)) {
    await writeSecret('resticPassword', randomBytes(32).toString('base64url'), 'Restic 仓库密码', runtimeConfig)
  }
  document.cloudBackup = next
  const written = await writeDocument(document, runtimeConfig)
  if (next.endpoint && next.bucket && await secretConfigured('s3AccessKeyId', runtimeConfig) && await secretConfigured('s3SecretAccessKey', runtimeConfig)) {
    await writeCloudEnvironment(next, runtimeConfig)
  }
  return cloudPublicState(written, runtimeConfig)
}

export async function managedCloudTestConfig(runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  if (!document.cloudBackup) throw new Error('请先保存云备份配置')
  return {
    ...document.cloudBackup,
    accessKeyId: await readSecret('s3AccessKeyId', runtimeConfig),
    secretAccessKey: await readSecret('s3SecretAccessKey', runtimeConfig),
    sessionToken: await readSecret('s3SessionToken', runtimeConfig).catch(() => '')
  }
}

export async function markManagedCloudVerified(runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  if (!document.cloudBackup) throw new Error('请先保存云备份配置')
  document.cloudBackup.verifiedFingerprint = await cloudFingerprint(document.cloudBackup, runtimeConfig)
  document.cloudBackup.verifiedAt = new Date().toISOString()
  const written = await writeDocument(document, runtimeConfig)
  await writeCloudEnvironment(written.cloudBackup, runtimeConfig)
  return cloudPublicState(written, runtimeConfig)
}

export async function managedMailRuntimeConfig(runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  return document.mail || null
}

export async function managedMailRuntimeConfigs(
  runtimeConfig = config,
  { updateToken = null } = {}
) {
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  const document = await readDocument(runtimeConfig)
  await assertManagedMailUpdateAvailable(runtimeConfig, { updateToken })
  if (!document.mail) {
    return [{
      ...runtimeConfig,
      emailPrimaryAccount: true,
      emailAccountLabel: '个人邮箱',
      emailManagedAccount: false,
      emailManagedAccountId: null
    }]
  }
  return [
    runtimeMailConfig(document.mail, runtimeConfig, { primary: true }),
    ...(document.mailAccounts || []).map((mail) => runtimeMailConfig(
      mail,
      runtimeConfig,
      { primary: false }
    ))
  ]
}

export const managedIntegrationSecretPaths = Object.freeze(
  Object.fromEntries(Object.entries(SECRET_FILES).map(([key, name]) => [key, (runtimeConfig = config) => exactPath(name, runtimeConfig)]))
)
