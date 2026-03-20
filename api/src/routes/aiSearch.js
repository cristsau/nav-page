import { getUserSettingValue } from '../lib/userSettings.js'

const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini'
const DEFAULT_OPENCLAW_MODEL = 'gpt-4.1-mini'

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
  const response = await fetch(url, options)
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, fallbackErrorMessage))
  }

  return payload
}

function buildExternalUrl(engineId, query) {
  const encoded = encodeURIComponent(query)

  switch (engineId) {
    case 'brave':
      return `https://search.brave.com/search?q=${encoded}`
    case 'openclaw':
      return ''
    case 'chatgpt':
      return 'https://chatgpt.com/'
    default:
      return ''
  }
}

function resolveChatEndpoint(provider) {
  const endpoint = normalizeText(provider?.endpoint)
  if (endpoint) {
    return endpoint
  }

  const proxyBaseUrl = normalizeText(provider?.cliProxyBaseUrl)
  if (proxyBaseUrl) {
    return `${proxyBaseUrl.replace(/\/$/, '')}/v1/chat/completions`
  }

  return DEFAULT_OPENAI_ENDPOINT
}

function resolveOpenClawEndpoint(provider) {
  const endpoint = normalizeText(provider?.endpoint)
  if (endpoint) {
    return endpoint
  }

  const baseUrl = normalizeText(provider?.baseUrl)
  if (!baseUrl) {
    return ''
  }

  return `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`
}

function extractChatText(payload) {
  if (!payload) return ''

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  if (Array.isArray(payload.output)) {
    const parts = []

    for (const item of payload.output) {
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (typeof content?.text === 'string') {
            parts.push(content.text)
          }
        }
      }
    }

    if (parts.length) {
      return parts.join('\n').trim()
    }
  }

  if (Array.isArray(payload.choices) && payload.choices.length) {
    const choice = payload.choices[0]
    const content = choice?.message?.content

    if (typeof content === 'string') {
      return content.trim()
    }

    if (Array.isArray(content)) {
      const text = content
        .map((item) => item?.text || item?.content || '')
        .filter(Boolean)
        .join('\n')
        .trim()

      if (text) {
        return text
      }
    }
  }

  return ''
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

async function runChatSearch(provider, queryText) {
  if (!provider?.enabled) {
    throw new Error('请先在设置中启用 ChatGPT / OpenAI 接入')
  }

  const apiKey = normalizeText(provider.apiKey)
  if (!apiKey) {
    throw new Error('请先在设置中填写 ChatGPT / OpenAI API Key')
  }

  const endpoint = resolveChatEndpoint(provider)
  const model = normalizeText(provider.model, DEFAULT_OPENAI_MODEL) || DEFAULT_OPENAI_MODEL
  const systemPrompt = [
      '你是 DOMO NAV 的 AI 搜索助手。',
    '请用简洁中文回答用户问题。',
    '如果没有联网或无法确认事实，请明确说明不确定，不要编造来源。',
    '优先给出可执行结论，再补充必要细节。'
  ].join(' ')

  const userPrompt = `用户搜索词：${queryText}`
  const usesResponsesApi = endpoint.includes('/responses')

  const payload = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        usesResponsesApi
          ? {
              model,
              input: `${systemPrompt}\n\n${userPrompt}`
            }
          : {
              model,
              temperature: 0.3,
              stream: false,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            }
      )
    },
    'AI 搜索请求失败'
  )

  const answer = extractChatText(payload)

  if (!answer) {
    throw new Error('AI 搜索未返回可解析的内容，请检查接口地址和模型配置')
  }

  return {
    engineId: 'chatgpt',
    label: 'AI 搜索',
    query: queryText,
    mode: 'answer',
    answer,
    items: [],
    externalUrl: buildExternalUrl('chatgpt', queryText)
  }
}

async function runOpenClawSearch(provider, queryText) {
  if (!provider?.enabled) {
    throw new Error('请先在设置中启用 OpenClaw 接入')
  }

  const endpoint = resolveOpenClawEndpoint(provider)
  if (!endpoint) {
    throw new Error('请先在设置中填写 OpenClaw Base URL 或 Endpoint')
  }

  const model = normalizeText(provider.model, DEFAULT_OPENCLAW_MODEL) || DEFAULT_OPENCLAW_MODEL
  const apiKey = normalizeText(provider.apiKey)
  const systemPrompt = [
      '你是 DOMO NAV 的 OpenClaw 搜索助手。',
    '请用简洁中文回答用户问题。',
    '如果无法确认事实，请明确说明不确定。'
  ].join(' ')

  const payload = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `用户搜索词：${queryText}` }
        ]
      })
    },
    'OpenClaw 搜索请求失败'
  )

  const answer = extractChatText(payload)

  if (!answer) {
    throw new Error('OpenClaw 未返回可解析内容，请检查接口地址和模型配置')
  }

  return {
    engineId: 'openclaw',
    label: 'OpenClaw',
    query: queryText,
    mode: 'answer',
    answer,
    items: [],
    externalUrl: normalizeText(provider.baseUrl)
  }
}

export default async function aiSearchRoutes(fastify) {
  fastify.post('/ai-search/providers/test', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const provider = normalizeText(request.body?.provider).toLowerCase()
    const inputConfig = request.body?.config || {}

    try {
      if (provider === 'brave') {
    const result = await runBraveSearch(inputConfig, 'DOMO NAV 浏览器书签 AI 搜索')
        return {
          ok: true,
          provider,
          message: result.items?.length
            ? `连接成功，拿到 ${result.items.length} 条结果，首条：${result.items[0].title}`
            : '连接成功，但这次测试没有返回结果'
        }
      }

      if (provider === 'chatgpt') {
        const result = await runChatSearch(inputConfig, '请只回复：连接成功')
        return {
          ok: true,
          provider,
          message: `连接成功，返回内容：${result.answer.slice(0, 120)}`
        }
      }

      if (provider === 'openclaw') {
        const result = await runOpenClawSearch(inputConfig, '请只回复：连接成功')
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

    const appConfig = await getUserSettingValue(request.currentUser.id, 'appConfig', {})
    const providers = appConfig?.search?.providers || {}

    try {
      if (engineId === 'brave') {
        return { result: await runBraveSearch(providers.brave || {}, queryText) }
      }

      if (engineId === 'chatgpt') {
        return { result: await runChatSearch(providers.chatgpt || {}, queryText) }
      }

      if (engineId === 'openclaw') {
        return { result: await runOpenClawSearch(providers.openclaw || {}, queryText) }
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
