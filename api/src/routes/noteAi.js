import { getUserSettingValue } from '../lib/userSettings.js'
import { consumeAiRateLimit } from '../lib/aiRateLimit.js'
import {
  NOTE_AI_ACTIONS,
  runNoteAi,
  selectNoteAiProvider
} from '../lib/noteAi.js'
import { normalizeExistingNoteTags } from '../lib/noteTags.js'

const MAX_TITLE_LENGTH = 300
const MAX_CONTENT_LENGTH = 40_000

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

export default async function noteAiRoutes(fastify) {
  fastify.post('/notes/ai', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const rateLimit = consumeAiRateLimit(request.currentUser.id)
    if (!rateLimit.allowed) {
      reply.header('Retry-After', String(rateLimit.retryAfterSeconds))
      reply.code(429)
      return { error: 'AI 编辑请求过于频繁，请稍后再试' }
    }

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
    const provider = selectNoteAiProvider(appConfig?.search?.providers || {})

    if (!provider) {
      reply.code(503)
      return { error: '请先在设置中启用 ChatGPT / OpenAI' }
    }

    try {
      return {
        result: await runNoteAi(provider, {
          action,
          type,
          title,
          content,
          tags
        }, request.currentUser.id)
      }
    } catch (error) {
      reply.code(502)
      return {
        error: error.message || 'AI 编辑执行失败'
      }
    }
  })
}
