import { removeSearchEngineReferences } from './searchEngines.js'

const PROVIDER_IDS = ['chatgpt', 'brave']
const RETIRED_OPENCLAW_ID = 'openclaw'
const PROVIDER_DESTINATION_FIELDS = Object.freeze({
  chatgpt: ['mode', 'apiMode', 'endpoint', 'cliProxyBaseUrl'],
  brave: ['endpoint']
})

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

export function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
  )
}

function normalizeKey(value) {
  return String(value ?? '').trim()
}

function getProvider(config, providerId) {
  const provider = config?.search?.providers?.[providerId]
  return isPlainObject(provider) ? provider : {}
}

function ensureProvider(config, providerId) {
  if (!isPlainObject(config.search)) {
    config.search = {}
  }

  if (!isPlainObject(config.search.providers)) {
    config.search.providers = {}
  }

  if (!isPlainObject(config.search.providers[providerId])) {
    config.search.providers[providerId] = {}
  }

  return config.search.providers[providerId]
}

function normalizeDestinationValue(value) {
  return String(value ?? '').trim()
}

export function sanitizeRetiredSearchProviders(value) {
  if (!isPlainObject(value)) {
    return value
  }

  // Retired providers must be removed before active-provider redaction so a
  // historical credential can never bypass the current allowlist.
  const sanitized = removeSearchEngineReferences(value, RETIRED_OPENCLAW_ID)
  const providers = sanitized?.search?.providers

  if (isPlainObject(providers)) {
    delete providers[RETIRED_OPENCLAW_ID]
  }

  return sanitized
}

export function hasProviderDestinationChanged(
  providerId,
  incomingProvider,
  existingProvider,
  { ignoreMissing = false } = {}
) {
  const fields = PROVIDER_DESTINATION_FIELDS[providerId] || []

  return fields.some((field) => {
    if (
      ignoreMissing
      && !Object.prototype.hasOwnProperty.call(incomingProvider || {}, field)
    ) {
      return false
    }

    return (
      normalizeDestinationValue(incomingProvider?.[field])
      !== normalizeDestinationValue(existingProvider?.[field])
    )
  })
}

export function redactAppConfigSecrets(value) {
  if (!isPlainObject(value)) {
    return value
  }

  const sanitized = sanitizeRetiredSearchProviders(value)
  const redacted = clone(sanitized)

  for (const providerId of PROVIDER_IDS) {
    const sourceProvider = getProvider(sanitized, providerId)
    const targetProvider = ensureProvider(redacted, providerId)
    targetProvider.apiKey = ''
    targetProvider.apiKeyConfigured = Boolean(normalizeKey(sourceProvider.apiKey))
    delete targetProvider.clearApiKey
  }

  return redacted
}

export function mergeAppConfigSecrets(incomingValue, existingValue) {
  if (!isPlainObject(incomingValue)) {
    throw new TypeError('appConfig value must be an object')
  }

  const merged = sanitizeRetiredSearchProviders(incomingValue)
  const sanitizedExisting = sanitizeRetiredSearchProviders(existingValue)

  for (const providerId of PROVIDER_IDS) {
    const incomingProvider = getProvider(merged, providerId)
    const existingProvider = getProvider(sanitizedExisting, providerId)
    const targetProvider = ensureProvider(merged, providerId)
    const incomingKey = normalizeKey(incomingProvider.apiKey)
    const existingKey = normalizeKey(existingProvider.apiKey)
    const destinationChanged = hasProviderDestinationChanged(
      providerId,
      incomingProvider,
      existingProvider
    )

    if (incomingProvider.clearApiKey === true) {
      targetProvider.apiKey = ''
    } else if (incomingKey) {
      targetProvider.apiKey = incomingKey
    } else if (destinationChanged) {
      // A credential is bound to the destination it was configured for. Reusing
      // it after an endpoint change could disclose the secret to another host.
      targetProvider.apiKey = ''
    } else {
      targetProvider.apiKey = existingKey
    }

    delete targetProvider.apiKeyConfigured
    delete targetProvider.clearApiKey
  }

  return merged
}

export function resolveProviderTestConfig(providerId, inputConfig, storedAppConfig) {
  if (!PROVIDER_IDS.includes(providerId)) {
    return clone(inputConfig || {})
  }

  const storedProvider = getProvider(storedAppConfig, providerId)
  const safeInput = isPlainObject(inputConfig)
    ? inputConfig
    : {}
  const inputKey = normalizeKey(safeInput.apiKey)
  const canReuseStoredKey = !hasProviderDestinationChanged(
    providerId,
    safeInput,
    storedProvider,
    { ignoreMissing: true }
  )

  return {
    ...clone(storedProvider),
    ...clone(safeInput),
    apiKey: inputKey || (
      canReuseStoredKey
        ? normalizeKey(storedProvider.apiKey)
        : ''
    )
  }
}
