export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra'

const RESPONSE_API_MODES = new Set(['responses', 'chat-completions'])
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const MODEL_ID_CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u
const MAX_MODEL_ID_LENGTH = 256

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

export function normalizeAiModelId(value, fallback = DEFAULT_OPENAI_MODEL) {
  const model = normalizeText(value, fallback) || fallback

  if (
    !model
    || [...model].length > MAX_MODEL_ID_LENGTH
    || MODEL_ID_CONTROL_PATTERN.test(model)
  ) {
    throw new Error('模型 ID 格式无效，请检查模型配置')
  }

  return model
}

export function resolveChatApiMode(provider = {}, endpoint = '') {
  const configuredMode = normalizeText(provider.apiMode).toLowerCase()
  if (RESPONSE_API_MODES.has(configuredMode)) {
    return configuredMode
  }

  if (normalizeText(endpoint).includes('/responses')) {
    return 'responses'
  }

  if (normalizeText(endpoint).includes('/chat/completions') || normalizeText(provider.cliProxyBaseUrl)) {
    return 'chat-completions'
  }

  return 'responses'
}

export function resolveChatEndpoint(provider = {}) {
  const proxyBaseUrl = normalizeText(provider.cliProxyBaseUrl)
  if (normalizeText(provider.mode).toLowerCase() === 'proxy' && proxyBaseUrl) {
    const suffix = resolveChatApiMode(provider) === 'responses'
      ? '/v1/responses'
      : '/v1/chat/completions'
    return `${proxyBaseUrl.replace(/\/$/, '')}${suffix}`
  }

  const endpoint = normalizeText(provider.endpoint)
  if (endpoint) {
    return endpoint
  }

  if (proxyBaseUrl) {
    const suffix = resolveChatApiMode(provider) === 'responses'
      ? '/v1/responses'
      : '/v1/chat/completions'
    return `${proxyBaseUrl.replace(/\/$/, '')}${suffix}`
  }

  return DEFAULT_OPENAI_ENDPOINT
}

export function extractAiText(payload) {
  if (!payload) return ''

  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim()
  }

  if (Array.isArray(payload.output)) {
    const parts = []

    for (const item of payload.output) {
      if (!Array.isArray(item?.content)) continue

      for (const content of item.content) {
        if (typeof content?.text === 'string' && content.text.trim()) {
          parts.push(content.text.trim())
        }
      }
    }

    if (parts.length) {
      return parts.join('\n').trim()
    }
  }

  if (Array.isArray(payload.choices) && payload.choices.length) {
    const content = payload.choices[0]?.message?.content

    if (typeof content === 'string') {
      return content.trim()
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => item?.text || item?.content || '')
        .filter(Boolean)
        .join('\n')
        .trim()
    }
  }

  return ''
}

export function extractResponseSources(payload) {
  const sources = []
  const seen = new Set()

  for (const outputItem of payload?.output || []) {
    for (const content of outputItem?.content || []) {
      for (const annotation of content?.annotations || []) {
        const citation = annotation?.url_citation || annotation
        const url = normalizeText(citation?.url)

        if (!url || seen.has(url)) continue

        try {
          const parsedUrl = new URL(url)
          if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue

          seen.add(url)
          sources.push({
            title: normalizeText(citation?.title, parsedUrl.hostname),
            url,
            description: 'AI 回答引用来源',
            source: parsedUrl.hostname
          })
        } catch {
          // Ignore malformed provider annotations.
        }
      }
    }
  }

  return sources.slice(0, 10)
}

export function buildChatRequest(provider, queryText, systemPrompt, safetyIdentifier = '') {
  const endpoint = resolveChatEndpoint(provider)
  const apiMode = resolveChatApiMode(provider, endpoint)
  const model = normalizeAiModelId(provider.model)

  if (apiMode === 'chat-completions') {
    return {
      endpoint,
      apiMode,
      model,
      body: {
        model,
        temperature: 0.3,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `用户搜索词：${queryText}` }
        ]
      }
    }
  }

  const effort = normalizeText(provider.reasoningEffort, 'low').toLowerCase()
  const body = {
    model,
    instructions: systemPrompt,
    input: `用户搜索词：${queryText}`,
    store: false,
    text: {
      verbosity: 'low'
    }
  }

  if (REASONING_EFFORTS.has(effort)) {
    body.reasoning = { effort }
  }

  if (provider.webSearchEnabled !== false) {
    body.tools = [{ type: 'web_search' }]
  }

  if (safetyIdentifier) {
    body.safety_identifier = safetyIdentifier
  }

  return {
    endpoint,
    apiMode,
    model,
    body
  }
}
