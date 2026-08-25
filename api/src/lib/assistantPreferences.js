import { AI_MODEL_MODES } from './aiProviderConfig.js'
import {
  normalizeAiModelId,
  normalizeReasoningEffort
} from './aiResponses.js'

const MODEL_MODES = new Set(Object.values(AI_MODEL_MODES))

export class AssistantPreferenceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AssistantPreferenceError'
    this.statusCode = 400
  }
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function readPreference(input, fallback, key, defaultValue) {
  if (input && Object.prototype.hasOwnProperty.call(input, key)) {
    return input[key]
  }
  if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) {
    return fallback[key]
  }
  return defaultValue
}

export function normalizeAssistantPreferences(input = {}, fallback = {}) {
  const modelMode = normalizeText(
    readPreference(input, fallback, 'modelMode', AI_MODEL_MODES.LATEST)
  ).toLowerCase()
  if (!MODEL_MODES.has(modelMode)) {
    throw new AssistantPreferenceError('模型选择方式无效，请重新选择')
  }

  let reasoningEffort
  try {
    reasoningEffort = normalizeReasoningEffort(
      readPreference(input, fallback, 'reasoningEffort', 'low'),
      'low'
    )
  } catch {
    throw new AssistantPreferenceError('推理强度无效，请重新选择')
  }

  if (modelMode === AI_MODEL_MODES.LATEST) {
    return {
      modelMode,
      model: null,
      reasoningEffort
    }
  }

  const rawModel = readPreference(input, fallback, 'model', '')
  let model
  try {
    model = normalizeAiModelId(rawModel, '')
  } catch {
    throw new AssistantPreferenceError('模型 ID 格式无效，请重新选择')
  }
  if (!model) {
    throw new AssistantPreferenceError('请选择一个可用模型')
  }

  return {
    modelMode,
    model,
    reasoningEffort
  }
}

export function applyAssistantPreferences(resolution, preferences) {
  const normalizedPreferences = normalizeAssistantPreferences(preferences)
  const catalog = resolution?.catalog || {}
  const provider = resolution?.provider || {}
  const allowedModels = new Set([
    ...(Array.isArray(catalog.models)
      ? catalog.models.map((model) => normalizeText(model?.id))
      : []),
    normalizeText(catalog.latestModelId),
    normalizeText(catalog.resolvedModelId)
  ].filter(Boolean))

  const model = normalizedPreferences.modelMode === AI_MODEL_MODES.LATEST
    ? normalizeText(catalog.latestModelId || catalog.resolvedModelId || provider.model)
    : normalizeText(normalizedPreferences.model)

  if (!model || !allowedModels.has(model)) {
    throw new AssistantPreferenceError('所选模型已不在服务端可用列表，请刷新后重新选择')
  }

  return {
    ...resolution,
    preferences: normalizedPreferences,
    provider: {
      ...provider,
      modelMode: normalizedPreferences.modelMode,
      model,
      reasoningEffort: normalizedPreferences.reasoningEffort
    }
  }
}
