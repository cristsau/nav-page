import { normalizeAiModelId } from './aiResponses.js'
import { AI_MODEL_MODES } from './aiProviderConfig.js'

const MODEL_PROVIDER_IDS = Object.freeze(['chatgpt'])
const MODEL_MODE_VALUES = new Set(Object.values(AI_MODEL_MODES))

export function validateAppConfigModelIds(config = {}) {
  const providers = config?.search?.providers

  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return
  }

  for (const providerId of MODEL_PROVIDER_IDS) {
    const provider = providers[providerId]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      continue
    }

    const modelMode = String(provider.modelMode ?? '').trim().toLowerCase()
    if (modelMode && !MODEL_MODE_VALUES.has(modelMode)) {
      throw new Error('模型选择模式无效，请选择自动最新或固定模型')
    }

    const model = String(provider.model ?? '').trim()
    if (!model) {
      continue
    }

    normalizeAiModelId(model, '')
  }
}
