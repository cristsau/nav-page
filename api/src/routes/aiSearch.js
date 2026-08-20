import { createHash } from 'node:crypto'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import {
  buildChatRequest,
  extractAiText,
  extractResponseSources
} from '../lib/aiResponses.js'
import {
  resolveChatProviderModel,
  toPublicModelCatalogResponse
} from '../lib/aiModelCatalog.js'
import { assertSafeOutboundEndpoint } from '../lib/outboundEndpoints.js'
import { resolveProviderTestConfig } from '../lib/settingsSecrets.js'
import { getUserSettingValue } from '../lib/userSettings.js'

const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const REQUEST_TIMEOUT_MS = 45000
const MAX_QUERY_LENGTH = 2000

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback

  if (typeof payload === 'string') {
    return payload
  }

  if (typeof payload.error === 'string') {
    return payload.error
  }

  if (typeof payload.message === 'string') {
    return payload.message
  }

  if (typeof payload.error?.message === 'string') {
    return payload.error.message
  }

  return fallback
}

async function fetchJson(url, options, fallbackErrorMessage) {
  const parsedUrl = await assertSafeOutboundEndpoint(url)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(parsedUrl, {
      ...options,
      signal: controller.signal,
      redirect: 'error'
    })
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text()

    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, fallbackErrorMessage))
    }

    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${fallbackErrorMessage}：请求超时`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function buildExternalUrl(engineId, query) {
  const encoded = encodeURIComponent(query)

  switch (engineId) {
    case 'brave':
      return `https://search.brave.com/search?q=${encoded}`
    case 'chatgpt':
      return 'https://chatgpt.com/'
    default:
      return ''
  }
}

async function runBraveSearch(provider, queryText) {
  if (!provider?.enabled) {
    throw new Error('请先在设置中启用 Brave Search API')
  }

  const apiKey = normalizeText(provider.apiKey)
  if (!apiKey) {
    throw new Error('请先在设置中填写 Brave Search API Key')
  }

  const endpoint = normalizeText(provider.endpoint, DEFAULT_BRAVE_ENDPOINT) || DEFAULT_BRAVE_ENDPOINT
  const url = new URL(endpoint)
  url.searchParams.set('q', queryText)
  url.searchParams.set('count', '6')
  url.searchParams.set('search_lang', 'zh-hans')

  const payload = await fetchJson(
    url.toString(),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey
      }
    },
    'Brave Search 请求失败'
  )

  const items = (payload?.web?.results || [])
    .slice(0, 6)
    .map((item) => ({
      title: normalizeText(item?.title, '未命名结果'),
      url: normalizeText(item?.url),
      description: normalizeText(item?.description),
      source: normalizeText(item?.meta_url?.hostname || item?.profile?.long_name || 'Brave Search')
    }))
    .filter((item) => item.url)

  return {
    engineId: 'brave',
    label: 'Brave Search',
    query: queryText,
    mode: 'links',
    answer: items.length ? '' : '没有找到结果，请尝试更换关键词。',
    items,
    externalUrl: buildExternalUrl('brave', queryText)
  }
}

async function runChatSearch(provider, queryText, userId = '') {
  const providerResolution = await resolveChatProviderModel(provider)
  const resolvedProvider = providerResolution.provider

  if (!resolvedProvider?.enabled) {
    throw new Error('请先在设置中启用 ChatGPT / OpenAI 接入')
  }

  const apiKey = normalizeText(resolvedProvider.apiKey)
  if (!apiKey) {
    throw new Error('请先在设置中填写 ChatGPT / OpenAI API Key')
  }

  const systemPrompt = [
    '你是 DOMO NAV 的 AI 搜索助手。',
    '请用简洁中文回答用户问题。',
    '如使用联网搜索，请只依据找到的来源回答；无法确认的事实要明确说明不确定。',
    '优先给出可执行结论，再补充必要细节。'
  ].join(' ')

  const safetyIdentifier = userId
    ? createHash('sha256').update(`domo-nav:${userId}`).digest('hex')
    : ''
  const chatRequest = buildChatRequest(
    resolvedProvider,
    queryText,
    systemPrompt,
    safetyIdentifier
  )

  const payload = await fetchJson(
    chatRequest.endpoint,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(chatRequest.body)
    },
    'AI 搜索请求失败'
  )

  const answer = extractAiText(payload)

  if (!answer) {
    throw new Error('AI 搜索未返回可解析的内容，请检查接口地址和模型配置')
  }

  return {
    engineId: 'chatgpt',
    label: 'AI 搜索',
    query: queryText,
    mode: 'answer',
    answer,
    items: chatRequest.apiMode === 'responses' ? extractResponseSources(payload) : [],
    externalUrl: buildExternalUrl('chatgpt', queryText),
    model: chatRequest.model,
    usage: payload?.usage || null
  }
}

export default async function aiSearchRoutes(fastify) {
  fastify.get('/ai-search/providers/chatgpt/models', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const appConfig = await getUserSettingValue(
      request.currentUser.id,
      'appConfig',
      {}
    )

    try {
      const resolution = await resolveChatProviderModel(
        appConfig?.search?.providers?.chatgpt || {},
        { discoverPinned: true }
      )

      return toPublicModelCatalogResponse(resolution.catalog)
    } catch {
      reply.code(503)
      return {
        error: 'AI 模型目录暂时不可用，请检查配置来源、接口地址和密钥'
      }
    }
  })

  fastify.post('/ai-search/providers/test', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const rateLimited = await enforceAiRateLimit(request, reply)
    if (rateLimited) return rateLimited

    const provider = normalizeText(request.body?.provider).toLowerCase()
    const inputConfig = request.body?.config || {}

    if (!['brave', 'chatgpt'].includes(provider)) {
      reply.code(400)
      return { error: 'Unsupported AI provider' }
    }

    const appConfig = await getUserSettingValue(request.currentUser.id, 'appConfig', {})
    const providerConfig = resolveProviderTestConfig(provider, inputConfig, appConfig)

    try {
      if (provider === 'brave') {
        const result = await runBraveSearch(providerConfig, 'DOMO NAV 浏览器书签 AI 搜索')
        return {
          ok: true,
          provider,
          message: result.items?.length
            ? `连接成功，拿到 ${result.items.length} 条结果，首条：${result.items[0].title}`
            : '连接成功，但这次测试没有返回结果'
        }
      }

      if (provider === 'chatgpt') {
        const result = await runChatSearch(providerConfig, '请只回复：连接成功', request.currentUser.id)
        return {
          ok: true,
          provider,
          message: `连接成功，返回内容：${result.answer.slice(0, 120)}`
        }
      }

      reply.code(400)
      return { error: 'Unsupported AI provider' }
    } catch (error) {
      reply.code(400)
      return {
        error: error.message || 'AI provider test failed'
      }
    }
  })

  fastify.post('/ai-search', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const rateLimited = await enforceAiRateLimit(request, reply)
    if (rateLimited) return rateLimited

    const engineId = normalizeText(request.body?.engineId).toLowerCase()
    const queryText = normalizeText(request.body?.query)

    if (!engineId) {
      reply.code(400)
      return { error: 'Search engine is required' }
    }

    if (!queryText) {
      reply.code(400)
      return { error: 'Search query is required' }
    }

    if (queryText.length > MAX_QUERY_LENGTH) {
      reply.code(400)
      return { error: `Search query must be ${MAX_QUERY_LENGTH} characters or fewer` }
    }

    const appConfig = await getUserSettingValue(request.currentUser.id, 'appConfig', {})
    const providers = appConfig?.search?.providers || {}

    try {
      if (engineId === 'brave') {
        return { result: await runBraveSearch(providers.brave || {}, queryText) }
      }

      if (engineId === 'chatgpt') {
        const chatProvider = request.body?.webSearchEnabled === false
          ? {
              ...(providers.chatgpt || {}),
              webSearchEnabled: false
            }
          : (providers.chatgpt || {})

        return {
          result: await runChatSearch(
            chatProvider,
            queryText,
            request.currentUser.id
          )
        }
      }

      reply.code(400)
      return { error: 'Unsupported AI search engine' }
    } catch (error) {
      reply.code(400)
      return {
        error: error.message || 'AI 搜索执行失败'
      }
    }
  })
}
