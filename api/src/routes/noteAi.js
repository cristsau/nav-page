import { getUserSettingValue } from '../lib/userSettings.js'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import {
  NOTE_AI_ACTIONS,
  runNoteAi,
  selectNoteAiProvider
} from '../lib/noteAi.js'
import { resolveChatProviderModel } from '../lib/aiModelCatalog.js'
import { normalizeExistingNoteTags } from '../lib/noteTags.js'
import {
  AI_USAGE_FEATURES
} from '../lib/aiUsage.js'
import { recordRuntimeAiUsageSafely } from '../lib/aiUsageRuntime.js'

const MAX_TITLE_LENGTH = 300
const MAX_CONTENT_LENGTH = 40_000

const NOTE_AI_FEATURES = Object.freeze({
  summarize: AI_USAGE_FEATURES.NOTE_SUMMARIZE,
  polish: AI_USAGE_FEATURES.NOTE_POLISH,
  tasks: AI_USAGE_FEATURES.NOTE_TASKS,
  continue: AI_USAGE_FEATURES.NOTE_CONTINUE,
  tags: AI_USAGE_FEATURES.NOTE_TAGS
})

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

export default async function noteAiRoutes(fastify) {
  fastify.post('/notes/ai', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const rateLimited = await enforceAiRateLimit(request, reply, {
      deniedError: 'AI 编辑请求过于频繁，请稍后再试'
    })
    if (rateLimited) return rateLimited

    const action = normalizeText(request.body?.action).toLowerCase()
    const type = normalizeText(request.body?.type, 'memo').toLowerCase() === 'diary'
      ? 'diary'
      : 'memo'
    const title = normalizeText(request.body?.title).slice(0, MAX_TITLE_LENGTH)
    const content = String(request.body?.content || '').trim()
    const tags = normalizeExistingNoteTags(request.body?.tags)

    if (!NOTE_AI_ACTIONS[action]) {
      reply.code(400)
      return { error: '请选择有效的 AI 编辑操作' }
    }

    if (action === 'tags' && !title && !content) {
      reply.code(400)
      return { error: '请先输入标题或正文内容' }
    }

    if (action !== 'tags' && !content) {
      reply.code(400)
      return { error: '请先输入正文内容' }
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      reply.code(400)
      return { error: `正文不能超过 ${MAX_CONTENT_LENGTH} 个字符` }
    }

    const appConfig = await getUserSettingValue(request.currentUser.id, 'appConfig', {})

    const startedAt = Date.now()
    let provider = null
    try {
      const resolution = await resolveChatProviderModel(
        appConfig?.search?.providers?.chatgpt || {}
      )
      provider = selectNoteAiProvider({
        chatgpt: resolution.provider
      })

      if (!provider) {
        await recordRuntimeAiUsageSafely({
          userId: request.currentUser.id,
          feature: NOTE_AI_FEATURES[action],
          provider: 'chatgpt',
          model: 'unknown',
          apiMode: 'unknown',
          success: false,
          usage: null,
          latencyMs: Math.max(0, Date.now() - startedAt)
        }, request.log)
        reply.code(503)
        return { error: '请先在设置中启用 ChatGPT / OpenAI' }
      }

      const result = await runNoteAi(provider, {
          action,
          type,
          title,
          content,
          tags
        }, request.currentUser.id)
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: NOTE_AI_FEATURES[action],
        provider: result.provider,
        model: result.model,
        apiMode: result.apiMode,
        success: true,
        usage: result.usage,
        latencyMs: result.latencyMs
      }, request.log)
      const {
        usage: _usage,
        apiMode: _apiMode,
        latencyMs: _latencyMs,
        ...publicResult
      } = result
      return {
        result: publicResult
      }
    } catch (error) {
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: NOTE_AI_FEATURES[action],
        provider: provider?.id || 'chatgpt',
        model: provider?.config?.model || 'unknown',
        apiMode: provider?.config?.apiMode || 'unknown',
        success: false,
        usage: null,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }, request.log)
      reply.code(502)
      return {
        error: error.message || 'AI 编辑执行失败'
      }
    }
  })
}
