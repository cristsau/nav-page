export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra'

export const RESPONSE_API_MODES = Object.freeze(['responses', 'chat-completions'])
export const REASONING_EFFORTS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])
const RESPONSE_API_MODE_VALUES = new Set(RESPONSE_API_MODES)
const REASONING_EFFORT_VALUES = new Set(REASONING_EFFORTS)
const MODEL_ID_CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u
const MAX_MODEL_ID_LENGTH = 256
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_FUNCTION_DESCRIPTION_LENGTH = 2_000
const MAX_FUNCTION_OUTPUT_LENGTH = 64_000
const MAX_RESPONSE_INPUT_ITEMS = 128

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

export function normalizeConfiguredChatApiMode(value, fallback = 'responses') {
  const normalized = normalizeText(value || fallback).toLowerCase()
  if (!RESPONSE_API_MODE_VALUES.has(normalized)) {
    throw new Error('API 格式无效，请选择 Responses API 或 Chat Completions')
  }
  return normalized
}

export function normalizeReasoningEffort(value, fallback = 'low') {
  const normalized = normalizeText(value || fallback).toLowerCase()
  if (!REASONING_EFFORT_VALUES.has(normalized)) {
    throw new Error('推理强度无效，请从页面提供的选项中选择')
  }
  return normalized
}

export function resolveChatApiMode(provider = {}, endpoint = '') {
  const configuredMode = normalizeText(provider.apiMode).toLowerCase()
  if (configuredMode) {
    return normalizeConfiguredChatApiMode(configuredMode)
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

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeFunctionName(value) {
  const name = normalizeText(value)
  if (!FUNCTION_NAME_PATTERN.test(name)) {
    throw new Error('函数工具名称格式无效')
  }
  return name
}

export function buildResponseFunctionTool({
  name,
  description = '',
  parameters = {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  strict = true
} = {}) {
  const normalizedName = normalizeFunctionName(name)
  const normalizedDescription = normalizeText(description)
  if ([...normalizedDescription].length > MAX_FUNCTION_DESCRIPTION_LENGTH) {
    throw new Error('函数工具说明过长')
  }
  if (!isObject(parameters) || parameters.type !== 'object') {
    throw new Error('函数工具参数必须是 object JSON Schema')
  }

  return {
    type: 'function',
    name: normalizedName,
    description: normalizedDescription,
    parameters,
    strict: strict !== false
  }
}

export function normalizeResponseFunctionTools(tools = []) {
  if (!Array.isArray(tools)) throw new Error('函数工具列表格式无效')
  const names = new Set()
  return tools.map((tool) => {
    const normalized = buildResponseFunctionTool(tool)
    if (names.has(normalized.name)) {
      throw new Error(`函数工具名称重复：${normalized.name}`)
    }
    names.add(normalized.name)
    return normalized
  })
}

export function normalizeResponseToolChoice(value) {
  if (value == null || value === '') return undefined
  if (typeof value === 'string') {
    const normalized = normalizeText(value).toLowerCase()
    if (!['auto', 'none', 'required'].includes(normalized)) {
      throw new Error('函数工具选择方式无效')
    }
    return normalized
  }
  if (isObject(value) && value.type === 'function') {
    return {
      type: 'function',
      name: normalizeFunctionName(value.name)
    }
  }
  throw new Error('函数工具选择方式无效')
}

function normalizeResponseInputItems(items) {
  if (!Array.isArray(items)) throw new Error('Responses input items 格式无效')
  if (items.length > MAX_RESPONSE_INPUT_ITEMS) {
    throw new Error('Responses input items 数量过多')
  }
  if (items.some((item) => !isObject(item))) {
    throw new Error('Responses input item 必须是对象')
  }
  return items
}

function parseFunctionArguments(value) {
  if (isObject(value)) return { input: value, argumentsJson: JSON.stringify(value) }
  const argumentsJson = typeof value === 'string' ? value : ''
  if (!argumentsJson) {
    return { input: null, argumentsJson, parseError: '函数参数为空' }
  }
  try {
    const parsed = JSON.parse(argumentsJson)
    if (!isObject(parsed)) {
      return { input: null, argumentsJson, parseError: '函数参数必须是 JSON 对象' }
    }
    return { input: parsed, argumentsJson }
  } catch {
    return { input: null, argumentsJson, parseError: '函数参数不是有效 JSON' }
  }
}

export function extractResponseFunctionCalls(payload) {
  return (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === 'function_call')
    .map((item) => {
      const parsed = parseFunctionArguments(item.arguments)
      return {
        id: normalizeText(item.id),
        callId: normalizeText(item.call_id || item.id),
        name: normalizeText(item.name),
        argumentsJson: parsed.argumentsJson,
        input: parsed.input,
        ...(parsed.parseError ? { parseError: parsed.parseError } : {})
      }
    })
}

export function buildResponseFunctionCallOutput(callId, output) {
  const normalizedCallId = normalizeText(callId)
  if (!normalizedCallId || [...normalizedCallId].length > 256 || MODEL_ID_CONTROL_PATTERN.test(normalizedCallId)) {
    throw new Error('函数调用 ID 格式无效')
  }
  const serialized = typeof output === 'string'
    ? output
    : JSON.stringify(output ?? null)
  if ([...serialized].length > MAX_FUNCTION_OUTPUT_LENGTH) {
    throw new Error('函数调用结果过长')
  }
  return {
    type: 'function_call_output',
    call_id: normalizedCallId,
    output: serialized
  }
}

export function buildChatRequest(
  provider,
  queryText,
  systemPrompt,
  safetyIdentifier = '',
  requestOptions = {}
) {
  const endpoint = resolveChatEndpoint(provider)
  const apiMode = resolveChatApiMode(provider, endpoint)
  const model = normalizeAiModelId(provider.model)
  const effort = normalizeReasoningEffort(provider.reasoningEffort, 'low')
  const functionTools = normalizeResponseFunctionTools(requestOptions.functionTools || [])
  const toolChoice = normalizeResponseToolChoice(requestOptions.toolChoice)

  if (apiMode === 'chat-completions') {
    if (requestOptions.inputItems) {
      throw new Error('函数调用结果续传仅支持 Responses API')
    }
    const body = {
      model,
      temperature: 0.3,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `用户搜索词：${queryText}` }
      ]
    }
    if (functionTools.length) {
      body.tools = functionTools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict
        }
      }))
      if (toolChoice) {
        body.tool_choice = typeof toolChoice === 'string'
          ? toolChoice
          : { type: 'function', function: { name: toolChoice.name } }
      }
    }
    return {
      endpoint,
      apiMode,
      model,
      body
    }
  }

  const body = {
    model,
    instructions: systemPrompt,
    input: requestOptions.inputItems
      ? normalizeResponseInputItems(requestOptions.inputItems)
      : `用户搜索词：${queryText}`,
    store: false,
    stream: false,
    text: {
      verbosity: 'low'
    }
  }

  body.reasoning = { effort }

  const tools = [
    ...(provider.webSearchEnabled !== false ? [{ type: 'web_search' }] : []),
    ...functionTools
  ]
  if (tools.length) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
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
