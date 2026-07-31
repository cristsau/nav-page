export const AI_MODEL_CATALOG_VERIFIED_AT = '2026-07-31'
export const DEFAULT_CHAT_MODEL_ID = 'gpt-5.6-terra'

export const CHAT_MODEL_CATALOG = Object.freeze([
  {
    id: 'gpt-5.6-terra',
    label: 'GPT 5.6 Terra',
    description: '生产已验证'
  },
  {
    id: 'gpt-5.4',
    label: 'GPT 5.4',
    description: '代理已配置'
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT 5.4 Mini',
    description: '代理已配置'
  },
  {
    id: 'gpt-5.4-sub2ai',
    label: 'GPT 5.4 Sub2AI',
    description: '代理已配置'
  },
  {
    id: 'gpt-5.2(high)',
    label: 'GPT 5.2 High',
    description: '代理已配置'
  },
  {
    id: 'glm-5-turbo',
    label: 'GLM 5 Turbo',
    description: 'OpenClaw 当前默认'
  }
])

const CHAT_API_MODES = new Set(['responses', 'chat-completions'])

function normalizeText(value) {
  return String(value ?? '').trim()
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
