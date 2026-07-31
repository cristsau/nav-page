import { normalizeAiModelId } from './aiResponses.js'

const MODEL_PROVIDER_IDS = Object.freeze(['chatgpt', 'openclaw'])

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

    const model = String(provider.model ?? '').trim()
    if (!model) {
      continue
    }

    normalizeAiModelId(model, '')
  }
}
