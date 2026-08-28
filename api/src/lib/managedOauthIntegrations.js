import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { config } from '../config.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'

const DOCUMENT_VERSION = 1
const CONFIG_FILE = 'oauth-integrations.json'
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{3,320}$/
const TENANT_PATTERN = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const PROVIDERS = new Set(['google', 'wechat'])
const EMAIL_PROVIDERS = new Set(['google', 'microsoft'])
const SECRET_FILES = Object.freeze({
  oauthStateKey: 'oauth-state-key',
  oauthSubjectKey: 'oauth-subject-key',
  googleClientSecret: 'oauth-google-client-secret',
  wechatClientSecret: 'oauth-wechat-client-secret',
  emailGoogleClientSecret: 'email-oauth-google-client-secret',
  emailGoogleRefreshToken: 'email-oauth-google-refresh-token',
  emailMicrosoftClientSecret: 'email-oauth-microsoft-client-secret',
  emailMicrosoftRefreshToken: 'email-oauth-microsoft-refresh-token'
})

let mutationQueue = Promise.resolve()

export function withOauthIntegrationMutation(callback) {
  const task = mutationQueue.then(callback, callback)
  mutationQueue = task.then(() => undefined, () => undefined)
  return task
}

function directory(runtimeConfig = config) {
  const value = String(runtimeConfig.managedIntegrationsDir || '').trim()
  if (!value || !path.isAbsolute(value)) {
    throw new Error('服务器尚未启用可管理集成目录')
  }
  return path.resolve(value)
}

function exactPath(fileName, runtimeConfig = config) {
  if (!/^[a-z0-9.-]+$/.test(String(fileName || ''))) {
    throw new Error('OAuth 集成文件名无效')
  }
  return path.join(directory(runtimeConfig), fileName)
}

async function ensureDirectory(runtimeConfig = config) {
  const target = directory(runtimeConfig)
  await fs.mkdir(target, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('可管理集成目录必须是普通目录')
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077)) {
    await fs.chmod(target, 0o700)
  }
  return target
}

async function atomicWrite(target, content) {
  await ensureDirectory({ ...config, managedIntegrationsDir: path.dirname(target) })
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  )
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, target)
    await fs.chmod(target, 0o600)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function bounded(value, maximum, label, { required = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').trim()
  if (text.length > maximum || CONTROL_PATTERN.test(text) || (required && !text)) {
    throw new TypeError(`${label}格式无效`)
  }
  return text
}

function clientId(value, label) {
  const text = bounded(value, 320, label)
  if (text && !CLIENT_ID_PATTERN.test(text)) throw new TypeError(`${label}格式无效`)
  return text
}

function secret(value, label) {
  const text = String(value ?? '').trim()
  if (!text || text.length > 8192 || CONTROL_PATTERN.test(text)) {
    throw new TypeError(`${label}格式无效`)
  }
  return text
}

function safeScope(value, fallback) {
  const scopes = [...new Set(String(value || fallback).split(/\s+/).filter(Boolean))]
  if (!scopes.length || scopes.length > 20 || scopes.some((item) => !/^[A-Za-z0-9._:/-]{1,160}$/.test(item))) {
    throw new TypeError('OAuth Scope 格式无效')
  }
  return scopes.join(' ')
}

function defaults() {
  return {
    version: DOCUMENT_VERSION,
    identity: {
      allowVerifiedEmailAutoLink: false,
      google: { enabled: false, clientId: '' },
      wechat: { enabled: false, clientId: '' }
    },
    emailOAuth: {
      selectedProvider: '',
      google: {
        enabled: false,
        clientId: '',
        scope: 'https://mail.google.com/'
      },
      microsoft: {
        enabled: false,
        clientId: '',
        tenant: 'common',
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access'
      }
    },
    updatedAt: null
  }
}

function normalizeDocument(value = {}) {
  const base = defaults()
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const identity = input.identity && typeof input.identity === 'object' ? input.identity : {}
  const mail = input.emailOAuth && typeof input.emailOAuth === 'object' ? input.emailOAuth : {}
  const googleMail = mail.google && typeof mail.google === 'object' ? mail.google : {}
  const microsoftMail = mail.microsoft && typeof mail.microsoft === 'object' ? mail.microsoft : {}
  const selectedProvider = String(mail.selectedProvider || '').trim().toLowerCase()
  if (selectedProvider && !EMAIL_PROVIDERS.has(selectedProvider)) {
    throw new TypeError('邮箱 OAuth Provider 无效')
  }
  const tenant = bounded(microsoftMail.tenant || 'common', 64, 'Microsoft Tenant', { required: true }).toLowerCase()
  if (!TENANT_PATTERN.test(tenant)) throw new TypeError('Microsoft Tenant 格式无效')
  return {
    version: DOCUMENT_VERSION,
    identity: {
      allowVerifiedEmailAutoLink: identity.allowVerifiedEmailAutoLink === true,
      google: {
        enabled: identity.google?.enabled === true,
        clientId: clientId(identity.google?.clientId, 'Google Client ID')
      },
      wechat: {
        enabled: identity.wechat?.enabled === true,
        clientId: clientId(identity.wechat?.clientId, '微信 AppID')
      }
    },
    emailOAuth: {
      selectedProvider,
      google: {
        enabled: googleMail.enabled === true,
        clientId: clientId(googleMail.clientId, 'Google 邮箱 Client ID'),
        scope: safeScope(googleMail.scope, base.emailOAuth.google.scope)
      },
      microsoft: {
        enabled: microsoftMail.enabled === true,
        clientId: clientId(microsoftMail.clientId, 'Microsoft Client ID'),
        tenant,
        scope: safeScope(microsoftMail.scope, base.emailOAuth.microsoft.scope)
      }
    },
    updatedAt: input.updatedAt || null
  }
}

async function readDocument(runtimeConfig = config) {
  if (!String(runtimeConfig.managedIntegrationsDir || '').trim()) return defaults()
  const target = exactPath(CONFIG_FILE, runtimeConfig)
  try {
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new Error('OAuth 集成配置文件不安全或过大')
    }
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'))
    if (parsed?.version !== DOCUMENT_VERSION) throw new Error('OAuth 集成配置版本无效')
    return normalizeDocument(parsed)
  } catch (error) {
    if (error?.code === 'ENOENT') return defaults()
    throw error
  }
}

async function writeDocument(document, runtimeConfig = config) {
  const normalized = normalizeDocument({ ...document, updatedAt: new Date().toISOString() })
  await ensureDirectory(runtimeConfig)
  await atomicWrite(exactPath(CONFIG_FILE, runtimeConfig), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

async function readSecret(name, runtimeConfig = config) {
  return readOwnerSecretFile(exactPath(SECRET_FILES[name], runtimeConfig), {
    label: name,
    maxBytes: 8192
  })
}

async function secretConfigured(name, runtimeConfig = config) {
  try {
    await readSecret(name, runtimeConfig)
    return true
  } catch {
    return false
  }
}

async function writeSecret(name, value, label, runtimeConfig = config) {
  await ensureDirectory(runtimeConfig)
  await atomicWrite(exactPath(SECRET_FILES[name], runtimeConfig), `${secret(value, label)}\n`)
}

async function ensureInternalKeys(runtimeConfig = config) {
  for (const key of ['oauthStateKey', 'oauthSubjectKey']) {
    if (!await secretConfigured(key, runtimeConfig)) {
      await writeSecret(key, randomBytes(48).toString('base64url'), key, runtimeConfig)
    }
  }
}

function providerSecretName(provider) {
  if (!PROVIDERS.has(provider)) throw new TypeError('OAuth Provider 无效')
  return provider === 'google' ? 'googleClientSecret' : 'wechatClientSecret'
}

function emailSecretNames(provider) {
  if (!EMAIL_PROVIDERS.has(provider)) throw new TypeError('邮箱 OAuth Provider 无效')
  return provider === 'google'
    ? ['emailGoogleClientSecret', 'emailGoogleRefreshToken']
    : ['emailMicrosoftClientSecret', 'emailMicrosoftRefreshToken']
}

async function publicState(document, runtimeConfig = config) {
  const [googleSecret, wechatSecret, googleMailSecret, googleRefresh, microsoftMailSecret, microsoftRefresh] = await Promise.all([
    secretConfigured('googleClientSecret', runtimeConfig),
    secretConfigured('wechatClientSecret', runtimeConfig),
    secretConfigured('emailGoogleClientSecret', runtimeConfig),
    secretConfigured('emailGoogleRefreshToken', runtimeConfig),
    secretConfigured('emailMicrosoftClientSecret', runtimeConfig),
    secretConfigured('emailMicrosoftRefreshToken', runtimeConfig)
  ])
  return {
    writable: await isWritable(runtimeConfig),
    identity: {
      allowVerifiedEmailAutoLink: document.identity.allowVerifiedEmailAutoLink,
      google: { ...document.identity.google, secretConfigured: googleSecret },
      wechat: { ...document.identity.wechat, secretConfigured: wechatSecret }
    },
    emailOAuth: {
      selectedProvider: document.emailOAuth.selectedProvider,
      google: {
        ...document.emailOAuth.google,
        clientSecretConfigured: googleMailSecret,
        refreshTokenConfigured: googleRefresh
      },
      microsoft: {
        ...document.emailOAuth.microsoft,
        clientSecretConfigured: microsoftMailSecret,
        refreshTokenConfigured: microsoftRefresh
      }
    },
    callbacks: {
      google: [
        'https://nav.skrskr.net/api/auth/oauth/google/callback',
        'https://nav.cristsau.cn/api/auth/oauth/google/callback'
      ],
      wechat: [
        'https://nav.skrskr.net/api/auth/oauth/wechat/callback',
        'https://nav.cristsau.cn/api/auth/oauth/wechat/callback'
      ]
    },
    updatedAt: document.updatedAt
  }
}

async function isWritable(runtimeConfig = config) {
  try {
    const target = directory(runtimeConfig)
    const stat = await fs.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    await fs.access(target, fsConstants.R_OK | fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function getManagedOauthState(runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  return publicState(document, runtimeConfig)
}

export async function saveIdentityOauthConfig(input = {}, runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  const next = normalizeDocument({
    ...document,
    identity: {
      allowVerifiedEmailAutoLink: input.allowVerifiedEmailAutoLink === true,
      google: {
        enabled: input.google?.enabled === true,
        clientId: input.google?.clientId ?? document.identity.google.clientId
      },
      wechat: {
        enabled: input.wechat?.enabled === true,
        clientId: input.wechat?.clientId ?? document.identity.wechat.clientId
      }
    }
  })
  await ensureInternalKeys(runtimeConfig)
  for (const provider of PROVIDERS) {
    const supplied = input[provider]?.clientSecret
    if (supplied) await writeSecret(providerSecretName(provider), supplied, `${provider} Client Secret`, runtimeConfig)
    const hasSecret = await secretConfigured(providerSecretName(provider), runtimeConfig)
    if (next.identity[provider].enabled && (!next.identity[provider].clientId || !hasSecret)) {
      throw new TypeError(`启用 ${provider} 登录前必须填写 Client ID 和 Client Secret`)
    }
  }
  const saved = await writeDocument(next, runtimeConfig)
  return (await publicState(saved, runtimeConfig)).identity
}

export async function saveEmailOauthConfig(input = {}, runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  const next = normalizeDocument({
    ...document,
    emailOAuth: {
      selectedProvider: input.selectedProvider ?? document.emailOAuth.selectedProvider,
      google: { ...document.emailOAuth.google, ...(input.google || {}) },
      microsoft: { ...document.emailOAuth.microsoft, ...(input.microsoft || {}) }
    }
  })
  await ensureInternalKeys(runtimeConfig)
  for (const provider of EMAIL_PROVIDERS) {
    const [clientSecretName, refreshTokenName] = emailSecretNames(provider)
    if (input[provider]?.clientSecret) {
      await writeSecret(clientSecretName, input[provider].clientSecret, `${provider} 邮箱 Client Secret`, runtimeConfig)
    }
    if (input[provider]?.refreshToken) {
      await writeSecret(refreshTokenName, input[provider].refreshToken, `${provider} 邮箱 Refresh Token`, runtimeConfig)
    }
    const ready = Boolean(
      next.emailOAuth[provider].clientId
      && await secretConfigured(clientSecretName, runtimeConfig)
      && await secretConfigured(refreshTokenName, runtimeConfig)
    )
    if (next.emailOAuth[provider].enabled && !ready) {
      throw new TypeError(`启用 ${provider} 邮箱 OAuth 前必须完整填写 Client ID、Client Secret 和 Refresh Token`)
    }
  }
  if (next.emailOAuth.selectedProvider && !next.emailOAuth[next.emailOAuth.selectedProvider].enabled) {
    throw new TypeError('选中的邮箱 OAuth Provider 尚未启用')
  }
  const saved = await writeDocument(next, runtimeConfig)
  return (await publicState(saved, runtimeConfig)).emailOAuth
}

export async function getIdentityProviderRuntime(provider, runtimeConfig = config) {
  if (!PROVIDERS.has(provider)) throw new TypeError('OAuth Provider 无效')
  const document = await readDocument(runtimeConfig)
  const providerConfig = document.identity[provider]
  const clientSecret = await readSecret(providerSecretName(provider), runtimeConfig).catch(() => '')
  return {
    provider,
    enabled: providerConfig.enabled && Boolean(providerConfig.clientId && clientSecret),
    clientId: providerConfig.clientId,
    clientSecret,
    allowVerifiedEmailAutoLink: document.identity.allowVerifiedEmailAutoLink
  }
}

export async function getOauthInternalKeys(runtimeConfig = config) {
  await ensureInternalKeys(runtimeConfig)
  return {
    stateKey: await readSecret('oauthStateKey', runtimeConfig),
    subjectKey: await readSecret('oauthSubjectKey', runtimeConfig)
  }
}

export async function getEmailOauthRuntime(provider, runtimeConfig = config) {
  if (!EMAIL_PROVIDERS.has(provider)) throw new TypeError('邮箱 OAuth Provider 无效')
  const document = await readDocument(runtimeConfig)
  const selected = document.emailOAuth.selectedProvider
  const providerConfig = document.emailOAuth[provider]
  const [clientSecretName, refreshTokenName] = emailSecretNames(provider)
  const [clientSecret, refreshToken] = await Promise.all([
    readSecret(clientSecretName, runtimeConfig).catch(() => ''),
    readSecret(refreshTokenName, runtimeConfig).catch(() => '')
  ])
  return {
    provider,
    enabled: selected === provider
      && providerConfig.enabled
      && Boolean(providerConfig.clientId && clientSecret && refreshToken),
    clientId: providerConfig.clientId,
    clientSecret,
    refreshToken,
    tenant: providerConfig.tenant || '',
    scope: providerConfig.scope
  }
}

export async function applyManagedOauthToRuntime(runtimeConfig = config) {
  const document = await readDocument(runtimeConfig)
  const selectedProvider = document.emailOAuth.selectedProvider
  const selectedRuntime = selectedProvider
    ? await getEmailOauthRuntime(selectedProvider, runtimeConfig)
    : null
  const effectiveProvider = selectedRuntime?.enabled ? selectedProvider : ''
  runtimeConfig.imapOauthProvider = effectiveProvider
  runtimeConfig.smtpOauthProvider = effectiveProvider
  return {
    source: effectiveProvider ? 'managed' : 'disabled',
    document
  }
}

export function identityOauthCallbacks() {
  return {
    google: [
      'https://nav.skrskr.net/api/auth/oauth/google/callback',
      'https://nav.cristsau.cn/api/auth/oauth/google/callback'
    ],
    wechat: [
      'https://nav.skrskr.net/api/auth/oauth/wechat/callback',
      'https://nav.cristsau.cn/api/auth/oauth/wechat/callback'
    ]
  }
}

export const OAUTH_PROVIDER_ENDPOINTS = Object.freeze({
  google: {
    discovery: 'https://accounts.google.com/.well-known/openid-configuration'
  },
  wechat: {
    authorization: 'https://open.weixin.qq.com/connect/qrconnect',
    token: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    userinfo: 'https://api.weixin.qq.com/sns/userinfo'
  }
})
