import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { config } from '../config.js'
import { DEFAULT_OPENAI_MODEL, normalizeAiModelId } from './aiResponses.js'

export const AI_MODEL_MODES = Object.freeze({
  LATEST: 'latest',
  PINNED: 'pinned'
})

const AI_MODEL_MODE_VALUES = new Set(Object.values(AI_MODEL_MODES))
const CLI_PROXY_API_MODES = new Set(['responses', 'chat-completions'])
const SECRET_MAX_BYTES = 4096
const SECRET_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const KNOWN_PROXY_SUFFIXES = Object.freeze([
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/models',
  '/v1'
])

function normalizeText(value) {
  return String(value ?? '').trim()
}

export function normalizeCliProxyBaseUrl(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    throw new Error('CLI Proxy Base URL is required')
  }

  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('CLI Proxy Base URL is invalid')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('CLI Proxy Base URL must use HTTPS')
  }

  if (parsed.username || parsed.password) {
    throw new Error('CLI Proxy Base URL cannot contain credentials')
  }

  if (parsed.search || parsed.hash) {
    throw new Error('CLI Proxy Base URL cannot contain a query or fragment')
  }

  let pathname = parsed.pathname.replace(/\/+$/, '')
  const lowerPathname = pathname.toLowerCase()
  const matchedSuffix = KNOWN_PROXY_SUFFIXES.find((suffix) => (
    lowerPathname === suffix
    || lowerPathname.endsWith(suffix)
  ))

  if (matchedSuffix) {
    pathname = pathname.slice(0, -matchedSuffix.length).replace(/\/+$/, '')
  }

  parsed.pathname = pathname || '/'
  parsed.search = ''
  parsed.hash = ''

  return parsed.toString().replace(/\/$/, '')
}

export function normalizeCliProxyApiMode(value, fallback = 'chat-completions') {
  const normalized = normalizeText(value || fallback).toLowerCase()
  if (!CLI_PROXY_API_MODES.has(normalized)) {
    throw new Error('CLI Proxy API mode must be responses or chat-completions')
  }
  return normalized
}

export function resolveConfiguredModelMode(provider = {}) {
  const configured = normalizeText(provider.modelMode).toLowerCase()
  if (AI_MODEL_MODE_VALUES.has(configured)) {
    return configured
  }

  const configuredModel = normalizeText(provider.model)
  return !configuredModel || configuredModel === DEFAULT_OPENAI_MODEL
    ? AI_MODEL_MODES.LATEST
    : AI_MODEL_MODES.PINNED
}

export function validateAiSecretFileStat(
  fileStat,
  { platform = process.platform } = {}
) {
  if (!fileStat?.isFile?.()) {
    throw new Error('CLI Proxy API key secret must be a regular file')
  }

  if (!Number.isSafeInteger(fileStat.size) || fileStat.size <= 0) {
    throw new Error('CLI Proxy API key secret is empty')
  }

  if (fileStat.size > SECRET_MAX_BYTES) {
    throw new Error('CLI Proxy API key secret is too large')
  }

  if (platform !== 'win32') {
    const permissions = Number(fileStat.mode) & 0o777
    if (
      (permissions & 0o400) === 0
      || (permissions & 0o177) !== 0
    ) {
      throw new Error('CLI Proxy API key secret must use owner-only permissions')
    }
  }
}

export async function readAiApiKeyFile(
  filePath,
  {
    lstatImpl = fs.lstat,
    openImpl = fs.open,
    platform = process.platform
  } = {}
) {
  const normalizedPath = normalizeText(filePath)
  if (!normalizedPath) {
    throw new Error('CLI Proxy API key secret file is not configured')
  }
  if (!path.isAbsolute(normalizedPath)) {
    throw new Error('CLI Proxy API key secret file must use an absolute path')
  }

  const linkStat = await lstatImpl(normalizedPath)
  if (linkStat?.isSymbolicLink?.()) {
    throw new Error('CLI Proxy API key secret cannot be a symbolic link')
  }
  validateAiSecretFileStat(linkStat, { platform })

  const noFollowFlag = platform === 'win32'
    ? 0
    : Number(fsConstants.O_NOFOLLOW || 0)
  const fileHandle = await openImpl(
    normalizedPath,
    fsConstants.O_RDONLY | noFollowFlag
  )

  let rawSecret
  try {
    const openedStat = await fileHandle.stat()
    validateAiSecretFileStat(openedStat, { platform })

    if (
      linkStat?.dev !== undefined
      && openedStat?.dev !== undefined
      && (
        String(linkStat.dev) !== String(openedStat.dev)
        || String(linkStat.ino) !== String(openedStat.ino)
      )
    ) {
      throw new Error('CLI Proxy API key secret changed while opening')
    }

    const chunks = []
    let position = 0
    while (position <= SECRET_MAX_BYTES) {
      const remaining = SECRET_MAX_BYTES + 1 - position
      const buffer = Buffer.alloc(Math.min(1024, remaining))
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        buffer.length,
        position
      )
      if (!bytesRead) break
      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    rawSecret = Buffer.concat(chunks).toString('utf8')
  } finally {
    await fileHandle.close()
  }

  const secret = rawSecret.trim()

  if (!secret) {
    throw new Error('CLI Proxy API key secret is empty')
  }

  if (
    Buffer.byteLength(secret, 'utf8') > SECRET_MAX_BYTES
    || secret.includes('\n')
    || secret.includes('\r')
    || SECRET_CONTROL_PATTERN.test(secret)
  ) {
    throw new Error('CLI Proxy API key secret has an invalid format')
  }

  return secret
}

export function hasServerManagedAiConfig(runtimeConfig = config) {
  return Boolean(
    normalizeText(runtimeConfig.aiCliProxyBaseUrl)
    || normalizeText(runtimeConfig.aiCliProxyApiKeyFile)
  )
}

export async function resolveChatProviderConfig(
  provider = {},
  {
    runtimeConfig = config,
    readSecretImpl = readAiApiKeyFile
  } = {}
) {
  const resolved = {
    ...(provider && typeof provider === 'object' && !Array.isArray(provider)
      ? provider
      : {})
  }
  const model = normalizeText(resolved.model) || DEFAULT_OPENAI_MODEL
  const modelMode = resolveConfiguredModelMode(resolved)
  const configuredBaseUrl = normalizeText(runtimeConfig.aiCliProxyBaseUrl)
  const configuredApiMode = normalizeCliProxyApiMode(
    runtimeConfig.aiCliProxyApiMode
  )
  const configuredSecretFile = normalizeText(runtimeConfig.aiCliProxyApiKeyFile)

  if (!configuredBaseUrl && !configuredSecretFile) {
    return {
      ...resolved,
      model: normalizeAiModelId(model),
      modelMode,
      serverManaged: false
    }
  }

  if (!configuredBaseUrl || !configuredSecretFile) {
    throw new Error('Server-managed CLI Proxy configuration is incomplete')
  }

  const apiKey = await readSecretImpl(configuredSecretFile)

  return {
    ...resolved,
    enabled: true,
    mode: 'proxy',
    apiMode: configuredApiMode,
    cliProxyBaseUrl: normalizeCliProxyBaseUrl(configuredBaseUrl),
    apiKey,
    model: normalizeAiModelId(model),
    modelMode,
    serverManaged: true
  }
}
