import { createHash } from 'node:crypto'
import { pool, query } from '../db/index.js'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import {
  buildChatRequest,
  extractAiText
} from '../lib/aiResponses.js'
import { resolveChatProviderModel } from '../lib/aiModelCatalog.js'
import { assertSafeOutboundEndpoint } from '../lib/outboundEndpoints.js'
import { getUserSettingValue } from '../lib/userSettings.js'
import { searchWorkspaceHybridForUser } from '../lib/hybridWorkspaceSearch.js'
import {
  buildAssistantPrompts,
  buildAssistantSources,
  buildRetrievalFallbackAnswer
} from '../lib/assistantContext.js'
import { AI_USAGE_FEATURES } from '../lib/aiUsage.js'
import { recordRuntimeAiUsageSafely } from '../lib/aiUsageRuntime.js'

const MAX_ASSISTANT_QUERY_LENGTH = 500
const REQUEST_TIMEOUT_MS = 45_000

function normalizeText(value) {
  return String(value ?? '').trim()
}

function extractErrorMessage(payload, fallback) {
  if (typeof payload === 'string' && payload.trim()) return payload.trim()
  if (typeof payload?.error === 'string') return payload.error
  if (typeof payload?.message === 'string') return payload.message
  if (typeof payload?.error?.message === 'string') return payload.error.message
  return fallback
}

async function runAssistantModel(provider, question, sources, userId) {
  const prompts = buildAssistantPrompts(question, sources)
  const safetyIdentifier = createHash('sha256')
    .update(`domo-nav-assistant:${userId}`)
    .digest('hex')
  const chatRequest = buildChatRequest(
    { ...provider, webSearchEnabled: false },
    prompts.userInput,
    prompts.systemPrompt,
    safetyIdentifier
  )
  await assertSafeOutboundEndpoint(chatRequest.endpoint)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(chatRequest.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${normalizeText(provider.apiKey)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(chatRequest.body),
      signal: controller.signal,
      redirect: 'error'
    })
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text()
    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, '个人助理请求失败'))
    }

    const answer = extractAiText(payload).slice(0, 20_000).trim()
    if (!answer) throw new Error('个人助理没有返回可解析的回答')
    return {
      answer,
      model: chatRequest.model,
      apiMode: chatRequest.apiMode,
      usage: payload?.usage || null
    }
  } finally {
    clearTimeout(timeout)
  }
}

function retrievalResponse(question, sources, degradedReason) {
  return {
    mode: 'retrieval',
    query: question,
    answer: buildRetrievalFallbackAnswer(sources),
    sources,
    model: '',
    degradedReason
  }
}

export default async function assistantRoutes(fastify) {
  fastify.post('/assistant/query', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAuth(request, reply)

    const rateLimited = await enforceAiRateLimit(request, reply, {
      deniedError: '个人助理请求过于频繁，请稍后再试'
    })
    if (rateLimited) return rateLimited

    const question = normalizeText(request.body?.query)
    if (!question) {
      reply.code(400)
      return { error: '请输入要查找的问题' }
    }
    if ([...question].length > MAX_ASSISTANT_QUERY_LENGTH) {
      reply.code(400)
      return { error: `问题不能超过 ${MAX_ASSISTANT_QUERY_LENGTH} 个字符` }
    }

    const searchResult = await searchWorkspaceHybridForUser({
      userId: request.currentUser.id,
      search: question,
      limit: 10,
      poolInstance: pool,
      queryFn: query,
      logger: request.log
    })
    const sources = buildAssistantSources(searchResult.results)

    if (!sources.length) {
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.ASSISTANT,
        provider: 'retrieval',
        model: 'none',
        apiMode: 'retrieval',
        success: true,
        usage: null,
        latencyMs: 0
      }, request.log)
      return retrievalResponse(question, sources, 'no-sources')
    }

    const appConfig = await getUserSettingValue(
      request.currentUser.id,
      'appConfig',
      {}
    )
    const providerConfig = appConfig?.search?.providers?.chatgpt || {}
    const startedAt = Date.now()
    let resolvedProvider = null

    try {
      const resolution = await resolveChatProviderModel(providerConfig)
      resolvedProvider = resolution.provider
      if (!resolvedProvider?.enabled || !normalizeText(resolvedProvider.apiKey)) {
        await recordRuntimeAiUsageSafely({
          userId: request.currentUser.id,
          feature: AI_USAGE_FEATURES.ASSISTANT,
          provider: 'retrieval',
          model: 'none',
          apiMode: 'retrieval',
          success: true,
          usage: null,
          latencyMs: Math.max(0, Date.now() - startedAt)
        }, request.log)
        return retrievalResponse(question, sources, 'not-configured')
      }

      const result = await runAssistantModel(
        resolvedProvider,
        question,
        sources,
        request.currentUser.id
      )
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.ASSISTANT,
        provider: 'chatgpt',
        model: result.model,
        apiMode: result.apiMode,
        success: true,
        usage: result.usage,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }, request.log)

      return {
        mode: 'answer',
        query: question,
        answer: result.answer,
        sources,
        model: result.model,
        degradedReason: ''
      }
    } catch (error) {
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.ASSISTANT,
        provider: 'chatgpt',
        model: resolvedProvider?.model || providerConfig.model || 'unknown',
        apiMode: resolvedProvider?.apiMode || providerConfig.apiMode || 'unknown',
        success: false,
        usage: null,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }, request.log)
      request.log?.warn?.(
        {
          errorCode: String(error?.code || error?.name || 'ASSISTANT_PROVIDER_ERROR')
            .replace(/[^A-Za-z0-9_.-]/g, '_')
            .slice(0, 64),
          feature: AI_USAGE_FEATURES.ASSISTANT
        },
        'personal assistant degraded to retrieval'
      )
      return retrievalResponse(question, sources, 'provider-unavailable')
    }
  })
}
