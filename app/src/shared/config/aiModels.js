export const AI_MODEL_CATALOG_VERIFIED_AT = '2026-07-31'
export const DEFAULT_CHAT_MODEL_ID = 'gpt-5.6-terra'
export const DEFAULT_CHAT_MODEL_MODE = 'latest'
export const AUTO_CHAT_MODEL_OPTION_ID = '__latest__'
export const MAX_DISCOVERED_CHAT_MODELS = 6

export const CHAT_MODEL_CATALOG = Object.freeze([
  {
    id: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    description: '旗舰模型，代理已验证'
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    description: '均衡模型，代理已验证'
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
    description: '高吞吐模型，代理已验证'
  },
  {
    id: 'gpt-5.5',
    label: 'GPT 5.5',
    description: '代理已验证'
  },
  {
    id: 'gpt-5.4',
    label: 'GPT 5.4',
    description: '代理已验证'
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT 5.4 Mini',
    description: '轻量模型，代理已验证'
  }
])

const CHAT_API_MODES = new Set(['responses', 'chat-completions'])

function normalizeText(value) {
  return String(value ?? '').trim()
}

function normalizeModelId(value) {
  const modelId = normalizeText(
    typeof value === 'string'
      ? value
      : value?.id || value?.model || value?.name
  )

  if (
    !modelId
    || modelId.length > 256
    || /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(modelId)
  ) {
    return ''
  }

  return modelId
}

export function normalizeChatModelMode(value) {
  return normalizeText(value).toLowerCase() === 'pinned'
    ? 'pinned'
    : DEFAULT_CHAT_MODEL_MODE
}

export function normalizeDiscoveredChatModels(
  models = [],
  limit = MAX_DISCOVERED_CHAT_MODELS
) {
  const normalizedLimit = Math.max(
    1,
    Math.min(MAX_DISCOVERED_CHAT_MODELS, Number(limit) || MAX_DISCOVERED_CHAT_MODELS)
  )
  const seen = new Set()
  const result = []

  for (const model of Array.isArray(models) ? models : []) {
    const id = normalizeModelId(model)
    if (!id || seen.has(id)) continue

    seen.add(id)
    result.push({
      id,
      label: normalizeText(typeof model === 'object' ? model.label : '') || id,
      description: normalizeText(typeof model === 'object' ? model.description : '') || 'CLI Proxy 可用'
    })

    if (result.length >= normalizedLimit) break
  }

  return result
}

export function buildChatModelPicker({
  currentModel = '',
  modelMode = DEFAULT_CHAT_MODEL_MODE,
  discoveredModels = [],
  latestModel = ''
} = {}) {
  const normalizedMode = normalizeChatModelMode(modelMode)
  const normalizedCurrent = normalizeModelId(currentModel)
  const normalizedDiscovered = normalizeDiscoveredChatModels(discoveredModels)
  const resolvedLatest = normalizeModelId(latestModel)
    || normalizedDiscovered[0]?.id
    || DEFAULT_CHAT_MODEL_ID
  const options = [...normalizedDiscovered]

  if (
    normalizedMode === 'pinned'
    && normalizedCurrent
    && !options.some(({ id }) => id === normalizedCurrent)
  ) {
    options.unshift({
      id: normalizedCurrent,
      label: normalizedCurrent,
      description: '当前固定配置（服务端未返回）'
    })
  }

  if (!normalizedDiscovered.length) {
    for (const fallbackModel of getChatModelOptions(normalizedCurrent || resolvedLatest)) {
      if (!options.some(({ id }) => id === fallbackModel.id)) {
        options.push(fallbackModel)
      }
    }
  }

  return {
    latestModel: resolvedLatest,
    selectionValue: normalizedMode === 'latest'
      ? AUTO_CHAT_MODEL_OPTION_ID
      : (normalizedCurrent || resolvedLatest),
    options
  }
}

export function resolveConfiguredChatApiMode(provider = {}) {
  const configuredMode = normalizeText(provider.apiMode).toLowerCase()
  if (CHAT_API_MODES.has(configuredMode)) {
    return configuredMode
  }

  const proxyBaseUrl = normalizeText(provider.cliProxyBaseUrl)
  if (normalizeText(provider.mode).toLowerCase() === 'proxy' && proxyBaseUrl) {
    return 'chat-completions'
  }

  const endpoint = normalizeText(provider.endpoint)
  if (endpoint.includes('/responses')) {
    return 'responses'
  }

  if (endpoint.includes('/chat/completions') || proxyBaseUrl) {
    return 'chat-completions'
  }

  return 'responses'
}

export function getChatModelOptions(currentModel = '') {
  const normalizedCurrent = normalizeText(currentModel)
  const isCatalogModel = CHAT_MODEL_CATALOG.some(({ id }) => id === normalizedCurrent)

  if (!normalizedCurrent || isCatalogModel) {
    return CHAT_MODEL_CATALOG
  }

  return Object.freeze([
    {
      id: normalizedCurrent,
      label: normalizedCurrent,
      description: '当前兼容配置'
    },
    ...CHAT_MODEL_CATALOG.slice(0, 5)
  ])
}
