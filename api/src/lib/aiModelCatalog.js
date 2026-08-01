import { createHash } from 'node:crypto'
import {
  AI_MODEL_MODES,
  normalizeCliProxyBaseUrl,
  resolveChatProviderConfig,
  resolveConfiguredModelMode
} from './aiProviderConfig.js'
import { DEFAULT_OPENAI_MODEL, normalizeAiModelId } from './aiResponses.js'
import { assertSafeOutboundEndpoint } from './outboundEndpoints.js'

export const AI_MODEL_CACHE_FRESH_MS = 10 * 60 * 1000
export const AI_MODEL_CACHE_STALE_MS = 24 * 60 * 60 * 1000
export const AI_MODEL_CACHE_MAX_ENTRIES = 128
export const AI_MODEL_CATALOG_LIMIT = 6

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000
const MODEL_DISCOVERY_MAX_BYTES = 512 * 1024
const GPT_VERSION_PATTERN = /^gpt[-_. ]*(\d+)(?:[._-](\d+))?(?:[._-](\d+))?(.*)$/i
const NON_TEXT_MODEL_PATTERN = /(embedding|image|dall[-_. ]?e|realtime|audio|transcrib|speech|tts|whisper|moderation|vision|search)/i
const SPECIALIZED_MODEL_PATTERN = /(codex|computer[-_. ]?use)/i
const LIGHTWEIGHT_MODEL_PATTERN = /(?:^|[-_. (])(mini|nano|micro|lite)(?:$|[-_. )])/i
const UNSTABLE_MODEL_PATTERN = /(?:^|[-_. (])(preview|alpha|beta|experimental|canary|dev|rc)(?:$|[-_. )])/i
const DATE_SNAPSHOT_PATTERN = /(?:^|[-_. (])20\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])(?:$|[-_. )])/i

function normalizeText(value) {
  return String(value ?? '').trim()
}

function compareNumberDescending(left, right) {
  return Number(right || 0) - Number(left || 0)
}

function buildModelsEndpoint(provider = {}) {
  const configuredBaseUrl = normalizeText(provider.cliProxyBaseUrl)
  const configuredEndpoint = normalizeText(provider.endpoint)
  const baseUrl = configuredBaseUrl || configuredEndpoint

  return `${normalizeCliProxyBaseUrl(baseUrl)}/v1/models`
}

export function parseGptModelId(value) {
  const id = normalizeText(value)
  const match = id.match(GPT_VERSION_PATTERN)
  if (!match) return null

  const suffix = normalizeText(match[4]).toLowerCase()
  const snapshot = DATE_SNAPSHOT_PATTERN.test(id)
  return {
    id,
    major: Number(match[1] || 0),
    minor: Number(match[2] || 0),
    patch: snapshot ? 0 : Number(match[3] || 0),
    suffix,
    snapshot,
    lightweight: LIGHTWEIGHT_MODEL_PATTERN.test(id),
    unstable: UNSTABLE_MODEL_PATTERN.test(id),
    specialized: SPECIALIZED_MODEL_PATTERN.test(id),
    nonText: NON_TEXT_MODEL_PATTERN.test(id)
  }
}

function getVariantRank(model) {
  if (!model.suffix) return 0
  if (model.lightweight) return 6
  if (model.unstable) return 7
  if (model.snapshot) return 8
  if (/(?:^|[-_. (])(sol|flagship)(?:$|[-_. )])/i.test(model.id)) return 1
  if (/(?:^|[-_. (])(pro|high)(?:$|[-_. )])/i.test(model.id)) return 2
  if (/(?:^|[-_. (])terra(?:$|[-_. )])/i.test(model.id)) return 3
  if (/(?:^|[-_. (])luna(?:$|[-_. )])/i.test(model.id)) return 4
  return 5
}

export function compareGptModels(left, right) {
  return (
    compareNumberDescending(left.major, right.major)
    || compareNumberDescending(left.minor, right.minor)
    || compareNumberDescending(left.patch, right.patch)
    || getVariantRank(left) - getVariantRank(right)
    || compareNumberDescending(left.created, right.created)
    || left.id.localeCompare(right.id, 'en')
  )
}

function isAutomaticModelCandidate(model) {
  return Boolean(
    model
    && !model.nonText
    && !model.specialized
    && !model.lightweight
    && !model.unstable
    && !model.snapshot
  )
}

function describeModel(model, latestModelId) {
  if (model.id === latestModelId) return '自动推荐'
  if (model.lightweight) return '轻量模型'
  if (model.unstable) return '预览模型'
  if (model.snapshot) return '日期快照'
  return '代理可用'
}

export function selectCliProxyChatModels(payload, { limit = AI_MODEL_CATALOG_LIMIT } = {}) {
  const upstreamModels = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : []
  const seen = new Set()
  const candidates = []

  for (const entry of upstreamModels) {
    const id = normalizeText(typeof entry === 'string' ? entry : entry?.id)
    const normalizedKey = id.toLowerCase()
    if (!id || seen.has(normalizedKey)) continue

    const parsed = parseGptModelId(id)
    if (!parsed || parsed.nonText || parsed.specialized) continue

    seen.add(normalizedKey)
    candidates.push({
      ...parsed,
      created: Number.isFinite(Number(entry?.created))
        ? Number(entry.created)
        : 0,
      ownedBy: normalizeText(entry?.owned_by)
    })
  }

  candidates.sort(compareGptModels)

  const latest = candidates.find(isAutomaticModelCandidate) || null
  const prioritized = latest
    ? [latest, ...candidates.filter((model) => model.id !== latest.id)]
    : candidates
  const selected = prioritized.slice(
    0,
    Math.max(1, Math.min(limit, AI_MODEL_CATALOG_LIMIT))
  )

  return {
    latestModelId: latest?.id || '',
    models: selected.map((model) => ({
      id: model.id,
      label: model.id,
      description: describeModel(model, latest?.id || '')
    }))
  }
}

async function readResponseTextLimited(
  response,
  maxBytes = MODEL_DISCOVERY_MAX_BYTES
) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maxBytes) {
    throw new Error('CLI Proxy model catalog response is too large')
  }

  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('CLI Proxy model catalog response is too large')
    }
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let result = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new Error('CLI Proxy model catalog response is too large')
      }

      result += decoder.decode(value, { stream: true })
    }

    return result + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function fetchCliProxyModels(
  provider,
  {
    fetchImpl = globalThis.fetch,
    assertEndpointImpl = assertSafeOutboundEndpoint,
    timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
    maxBytes = MODEL_DISCOVERY_MAX_BYTES
  } = {}
) {
  const apiKey = normalizeText(provider.apiKey)
  if (!apiKey) {
    throw new Error('CLI Proxy API key is not configured')
  }

  const endpoint = buildModelsEndpoint(provider)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortPromise = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })

  try {
    const safeEndpoint = await Promise.race([
      assertEndpointImpl(endpoint),
      abortPromise
    ])
    const response = await fetchImpl(safeEndpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      redirect: 'error'
    })

    if (!response.ok) {
      throw new Error(`CLI Proxy model discovery failed with status ${response.status}`)
    }

    const responseText = await readResponseTextLimited(response, maxBytes)
    let payload

    try {
      payload = JSON.parse(responseText)
    } catch {
      throw new Error('CLI Proxy model catalog is not valid JSON')
    }

    const catalog = selectCliProxyChatModels(payload)
    if (!catalog.models.length || !catalog.latestModelId) {
      throw new Error('CLI Proxy returned no compatible GPT models')
    }

    return catalog
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('CLI Proxy model discovery timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function createCacheKey(provider) {
  const endpoint = buildModelsEndpoint(provider)
  const apiKey = normalizeText(provider.apiKey)
  return createHash('sha256')
    .update(endpoint)
    .update('\0')
    .update(apiKey)
    .digest('hex')
}

function isoTimestamp(value) {
  return Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null
}

function buildFallbackCatalog(provider, source = 'fallback') {
  const fallbackModel = normalizeAiModelId(
    normalizeText(provider.model) || DEFAULT_OPENAI_MODEL
  )
  return {
    models: [{
      id: fallbackModel,
      label: fallbackModel,
      description: '已配置回退'
    }],
    latestModelId: fallbackModel,
    source,
    stale: source !== 'cache' && source !== 'live',
    verifiedAt: null
  }
}

function buildCatalogResult(catalog, {
  source,
  verifiedAt
}) {
  return {
    models: catalog.models.slice(0, AI_MODEL_CATALOG_LIMIT),
    latestModelId: catalog.latestModelId,
    source,
    stale: source === 'stale',
    verifiedAt: isoTimestamp(verifiedAt)
  }
}

export function createAiModelCatalog({
  fetchImpl = globalThis.fetch,
  assertEndpointImpl = assertSafeOutboundEndpoint,
  now = () => Date.now(),
  freshMs = AI_MODEL_CACHE_FRESH_MS,
  staleMs = AI_MODEL_CACHE_STALE_MS,
  maxEntries = AI_MODEL_CACHE_MAX_ENTRIES,
  timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
  maxBytes = MODEL_DISCOVERY_MAX_BYTES
} = {}) {
  const cache = new Map()

  function touchCacheEntry(cacheKey, entry) {
    cache.delete(cacheKey)
    cache.set(cacheKey, {
      ...entry,
      lastAccessAt: now()
    })
  }

  function enforceCacheLimit() {
    while (cache.size > Math.max(1, maxEntries)) {
      const candidate = [...cache.entries()]
        .find(([, entry]) => !entry.promise)
        || cache.entries().next().value
      if (!candidate) break
      cache.delete(candidate[0])
    }
  }

  async function discover(provider, { force = false } = {}) {
    let cacheKey
    try {
      cacheKey = createCacheKey(provider)
    } catch {
      return buildFallbackCatalog(provider)
    }

    const requestedAt = now()
    const existing = cache.get(cacheKey)

    if (
      !force
      && existing?.catalog
      && requestedAt - existing.verifiedAt <= freshMs
    ) {
      touchCacheEntry(cacheKey, existing)
      return buildCatalogResult(existing.catalog, {
        source: 'cache',
        verifiedAt: existing.verifiedAt
      })
    }

    if (existing?.promise) {
      touchCacheEntry(cacheKey, existing)
      return existing.promise
    }

    const refreshPromise = (async () => {
      try {
        const catalog = await fetchCliProxyModels(provider, {
          fetchImpl,
          assertEndpointImpl,
          timeoutMs,
          maxBytes
        })
        const verifiedAt = now()
        cache.set(cacheKey, {
          catalog,
          verifiedAt,
          lastAccessAt: verifiedAt,
          promise: null
        })
        enforceCacheLimit()
        return buildCatalogResult(catalog, {
          source: 'live',
          verifiedAt
        })
      } catch {
        const failedAt = now()
        if (
          existing?.catalog
          && failedAt - existing.verifiedAt <= staleMs
        ) {
          cache.set(cacheKey, {
            ...existing,
            lastAccessAt: failedAt,
            promise: null
          })
          return buildCatalogResult(existing.catalog, {
            source: 'stale',
            verifiedAt: existing.verifiedAt
          })
        }

        cache.delete(cacheKey)
        return buildFallbackCatalog(provider)
      }
    })()

    cache.set(cacheKey, {
      ...(existing || {}),
      lastAccessAt: requestedAt,
      promise: refreshPromise
    })
    enforceCacheLimit()
    return refreshPromise
  }

  return {
    discover,
    get size() {
      return cache.size
    },
    clear() {
      cache.clear()
    }
  }
}

export const aiModelCatalog = createAiModelCatalog()

export async function resolveChatProviderModel(
  provider = {},
  {
    runtimeConfig,
    readSecretImpl,
    catalog = aiModelCatalog,
    discoverPinned = false
  } = {}
) {
  const resolvedProvider = await resolveChatProviderConfig(provider, {
    ...(runtimeConfig ? { runtimeConfig } : {}),
    ...(readSecretImpl ? { readSecretImpl } : {})
  })
  const configuredMode = resolveConfiguredModelMode(resolvedProvider)

  if (configuredMode === AI_MODEL_MODES.PINNED && !discoverPinned) {
    const resolvedModelId = normalizeAiModelId(resolvedProvider.model)
    return {
      provider: {
        ...resolvedProvider,
        modelMode: configuredMode,
        model: resolvedModelId
      },
      catalog: {
        ...buildFallbackCatalog(resolvedProvider),
        resolvedModelId,
        configuredMode,
        serverManaged: Boolean(resolvedProvider.serverManaged)
      }
    }
  }

  const discovered = await catalog.discover(resolvedProvider)
  const resolvedModelId = configuredMode === AI_MODEL_MODES.PINNED
    ? normalizeAiModelId(resolvedProvider.model)
    : normalizeAiModelId(
        discovered.latestModelId || resolvedProvider.model || DEFAULT_OPENAI_MODEL
      )

  return {
    provider: {
      ...resolvedProvider,
      modelMode: configuredMode,
      model: resolvedModelId
    },
    catalog: {
      ...discovered,
      resolvedModelId,
      configuredMode,
      serverManaged: Boolean(resolvedProvider.serverManaged)
    }
  }
}

export function toPublicModelCatalogResponse(catalog = {}) {
  return {
    provider: 'chatgpt',
    models: Array.isArray(catalog.models)
      ? catalog.models.slice(0, AI_MODEL_CATALOG_LIMIT).map((model) => ({
          id: normalizeText(model?.id),
          label: normalizeText(model?.label || model?.id),
          description: normalizeText(model?.description)
        })).filter((model) => model.id)
      : [],
    latestModelId: normalizeText(catalog.latestModelId),
    resolvedModelId: normalizeText(catalog.resolvedModelId),
    configuredMode: catalog.configuredMode === AI_MODEL_MODES.PINNED
      ? AI_MODEL_MODES.PINNED
      : AI_MODEL_MODES.LATEST,
    source: ['live', 'cache', 'stale', 'fallback'].includes(catalog.source)
      ? catalog.source
      : 'fallback',
    stale: Boolean(catalog.stale),
    verifiedAt: normalizeText(catalog.verifiedAt) || null,
    serverManaged: Boolean(catalog.serverManaged)
  }
}
