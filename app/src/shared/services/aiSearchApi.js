import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'
import { getCurrentUserId } from '@/shared/db/database'
import {
  DEFAULT_CHAT_MODEL_ID,
  normalizeDiscoveredChatModels
} from '@/shared/config/aiModels'

const CHAT_MODEL_CACHE_KEY_PREFIX = 'domo-nav:chat-model-catalog:v1'
const CHAT_MODEL_CACHE_TTL_MS = 15 * 60 * 1000
const chatModelMemoryCache = new Map()

function normalizeText(value) {
  return String(value ?? '').trim()
}

function getSessionStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

function getChatModelCacheKey() {
  return `${CHAT_MODEL_CACHE_KEY_PREFIX}:${normalizeText(getCurrentUserId()) || 'anonymous'}`
}

function normalizeChatModelCatalog(payload = {}) {
  const source = payload?.result || payload?.catalog || payload
  const rawModels = source?.models || source?.data || []
  const models = normalizeDiscoveredChatModels(rawModels)
  const catalogSource = normalizeText(source?.source) || 'live'
  const latestModel = normalizeText(
    source?.latestModelId
      || source?.latestModel
      || source?.latest
      || source?.resolvedModelId
      || source?.resolvedLatestModel
      || models[0]?.id
      || DEFAULT_CHAT_MODEL_ID
  )

  return {
    models,
    latestModel,
    resolvedModel: normalizeText(source?.resolvedModelId) || latestModel,
    configuredMode: normalizeText(source?.configuredMode),
    verifiedAt: normalizeText(source?.verifiedAt),
    fetchedAt: normalizeText(source?.fetchedAt || source?.verifiedAt) || new Date().toISOString(),
    providerCached: Boolean(source?.cached) || ['cache', 'stale', 'fallback'].includes(catalogSource),
    providerStale: Boolean(source?.stale) || catalogSource === 'stale',
    serverManaged: source?.serverManaged !== false,
    source: catalogSource
  }
}

function readChatModelCache() {
  const cacheKey = getChatModelCacheKey()
  if (chatModelMemoryCache.has(cacheKey)) {
    return chatModelMemoryCache.get(cacheKey)
  }

  const storage = getSessionStorage()
  if (!storage) return null

  try {
    const cached = JSON.parse(storage.getItem(cacheKey) || 'null')
    if (!cached || !Array.isArray(cached.models) || !cached.cachedAt) return null

    const normalizedCache = {
      ...cached,
      models: normalizeDiscoveredChatModels(cached.models)
    }
    chatModelMemoryCache.set(cacheKey, normalizedCache)
    return normalizedCache
  } catch {
    return null
  }
}

function writeChatModelCache(catalog) {
  const safeCatalog = {
    ...catalog,
    cachedAt: Date.now()
  }
  const cacheKey = getChatModelCacheKey()
  chatModelMemoryCache.set(cacheKey, safeCatalog)

  try {
    getSessionStorage()?.setItem(cacheKey, JSON.stringify(safeCatalog))
  } catch {
    // Model IDs are still available in memory when browser storage is unavailable.
  }

  return safeCatalog
}

export function shouldUseBackendAiSearch() {
  return isBackendAuthEnabled()
}

export async function runBackendAiSearch(engineId, query, options = {}) {
  const payload = await request('/ai-search', {
    method: 'POST',
    body: JSON.stringify({
      engineId,
      query,
      ...(options.webSearchEnabled === false
        ? { webSearchEnabled: false }
        : {})
    })
  })

  return payload.result
}

export async function testBackendAiProvider(provider, config) {
  return request('/ai-search/providers/test', {
    method: 'POST',
    body: JSON.stringify({ provider, config })
  })
}

export async function fetchBackendChatModels({ force = false } = {}) {
  const cached = readChatModelCache()
  const cacheIsFresh = cached
    && Date.now() - Number(cached.cachedAt) < CHAT_MODEL_CACHE_TTL_MS

  if (!force && cacheIsFresh) {
    return {
      ...cached,
      cached: true,
      stale: Boolean(cached.providerStale),
      cacheLayer: 'browser'
    }
  }

  try {
    const payload = await request('/ai-search/providers/chatgpt/models', {
      method: 'GET'
    })
    const catalog = normalizeChatModelCatalog(payload)

    if (!catalog.models.length) {
      throw new Error('CLI Proxy 没有返回可用模型')
    }

    const stored = writeChatModelCache(catalog)
    return {
      ...stored,
      cached: stored.providerCached,
      stale: stored.providerStale,
      cacheLayer: stored.providerCached ? 'server' : 'network'
    }
  } catch (error) {
    if (cached?.models?.length) {
      return {
        ...cached,
        cached: true,
        stale: true,
        cacheLayer: 'browser',
        error: error.message || '动态模型列表加载失败'
      }
    }

    throw error
  }
}
