import { createHash } from 'node:crypto'
import { pool, query, withTransaction } from '../db/index.js'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import { buildChatRequest, extractAiText } from '../lib/aiResponses.js'
import { resolveChatProviderModel } from '../lib/aiModelCatalog.js'
import {
  applyAssistantPreferences,
  AssistantPreferenceError,
  normalizeAssistantPreferences
} from '../lib/assistantPreferences.js'
import { assertSafeOutboundEndpoint } from '../lib/outboundEndpoints.js'
import { getUserSettingValue } from '../lib/userSettings.js'
import { searchWorkspaceHybridForUser } from '../lib/hybridWorkspaceSearch.js'
import { searchEmailSources } from '../lib/emailEvents.js'
import { decryptEmailPayload, encryptEmailPayload } from '../lib/emailCrypto.js'
import {
  buildAssistantPrompts,
  buildAssistantSources,
  buildRetrievalFallbackAnswer,
  redactAssistantContext
} from '../lib/assistantContext.js'
import { AI_USAGE_FEATURES } from '../lib/aiUsage.js'
import { recordRuntimeAiUsageSafely } from '../lib/aiUsageRuntime.js'

const MAX_ASSISTANT_QUERY_LENGTH = 500
const MAX_ASSISTANT_ANSWER_LENGTH = 20_000
const MAX_CONVERSATION_HISTORY = 12
const REQUEST_TIMEOUT_MS = 60_000
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function normalizeText(value) {
  return String(value ?? '').trim()
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''))
}

function extractErrorMessage(payload, fallback) {
  if (typeof payload === 'string' && payload.trim()) return payload.trim()
  if (typeof payload?.error === 'string') return payload.error
  if (typeof payload?.message === 'string') return payload.message
  if (typeof payload?.error?.message === 'string') return payload.error.message
  return fallback
}

function mapConversation(row) {
  return {
    id: row.id,
    title: row.title,
    modelMode: row.model_mode || 'latest',
    model: row.model || '',
    reasoningEffort: row.reasoning_effort || 'low',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preview: row.preview || '',
    messageCount: Number(row.message_count || 0)
  }
}

function mapMessage(row, overrides = {}) {
  return {
    id: row.id,
    role: row.role,
    content: overrides.content ?? row.content,
    sources: overrides.sources ?? (Array.isArray(row.sources) ? row.sources : []),
    provider: row.provider || '',
    model: row.model || '',
    createdAt: row.created_at
  }
}

function assistantMessageEncryptionContext(userId, conversationId) {
  return `assistant:${String(userId || '')}:${String(conversationId || '')}`
}

function sourcesForPersistence(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => {
    if (source?.kind !== 'email') return source
    return {
      sourceId: source.sourceId,
      recordId: source.recordId,
      kind: 'email',
      kindLabel: source.kindLabel || '邮件',
      title: '邮件来源（登录后打开查看）',
      excerpt: '',
      href: source.href || ''
    }
  })
}

async function resolveStoredMessageContent(row, userId) {
  if (row.content_sensitive !== true) return row.content
  try {
    const payload = await decryptEmailPayload(row.content_encrypted, {
      context: assistantMessageEncryptionContext(userId, row.conversation_id)
    })
    return normalizeText(payload?.content) || '邮件相关回答为空'
  } catch {
    return '邮件相关回答暂时无法解密，请管理员检查邮件加密密钥。'
  }
}

async function mapStoredMessage(row, userId) {
  return mapMessage(row, {
    content: await resolveStoredMessageContent(row, userId)
  })
}

async function prepareAssistantAnswerForStorage({
  answer,
  sources,
  userId,
  conversationId,
  logger
}) {
  const storedSources = sourcesForPersistence(sources)
  const containsEmail = (sources || []).some((source) => source?.kind === 'email')
  if (!containsEmail) {
    return {
      content: answer,
      contentEncrypted: null,
      contentSensitive: false,
      sources: storedSources
    }
  }
  try {
    return {
      content: '[邮件相关回答已加密]',
      contentEncrypted: await encryptEmailPayload({ content: answer }, {
        context: assistantMessageEncryptionContext(userId, conversationId)
      }),
      contentSensitive: true,
      sources: storedSources
    }
  } catch (error) {
    logger?.warn?.(
      { errorCode: String(error?.code || error?.name || 'ASSISTANT_ENCRYPTION_ERROR').slice(0, 64) },
      'email-derived assistant answer could not be encrypted and was not persisted'
    )
    return {
      content: '[邮件相关回答未保存：加密密钥不可用]',
      contentEncrypted: null,
      contentSensitive: false,
      sources: storedSources
    }
  }
}

async function findConversation(client, userId, conversationId) {
  if (!isUuid(conversationId)) return null
  const { rows } = await client.query(
    `SELECT * FROM assistant_conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [conversationId, userId]
  )
  return rows[0] || null
}

function conversationPreferenceFallback(row) {
  return {
    modelMode: row?.model_mode || 'latest',
    model: row?.model || '',
    reasoningEffort: row?.reasoning_effort || 'low'
  }
}

async function createConversation(
  client,
  userId,
  title = '新对话',
  preferences = normalizeAssistantPreferences()
) {
  const safeTitle = normalizeText(title).slice(0, 160) || '新对话'
  const { rows } = await client.query(
    `INSERT INTO assistant_conversations (
       user_id, title, model_mode, model, reasoning_effort
     ) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      userId,
      safeTitle,
      preferences.modelMode,
      preferences.model,
      preferences.reasoningEffort
    ]
  )
  return rows[0]
}

async function recentConversationHistory(client, userId, conversationId) {
  const { rows } = await client.query(
    `SELECT conversation_id, role, content, content_encrypted, content_sensitive
     FROM assistant_messages
     WHERE user_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [userId, conversationId, MAX_CONVERSATION_HISTORY]
  )
  const chronological = rows.reverse()
  return Promise.all(chronological.map(async (row) => ({
    role: row.role,
    content: await resolveStoredMessageContent(row, userId)
  })))
}

async function reminderSourcesForUser(userId, question) {
  const normalized = normalizeText(question)
  const broadReminderQuery = /(今天|今日|待办|到期|提醒|处理|what.*(?:today|todo|due))/iu.test(normalized)
  if (!broadReminderQuery) return []
  const { rows } = await query(
    `SELECT reminder.id, reminder.due_at_snapshot, note.id AS note_id,
            note.title, note.number_id
     FROM note_reminders AS reminder
     JOIN notes AS note ON note.id = reminder.note_id
     WHERE reminder.user_id = $1
       AND reminder.read_at IS NULL
       AND note.encrypted = FALSE
       AND note.completed = FALSE
     ORDER BY reminder.due_at_snapshot ASC, reminder.id ASC
     LIMIT 5`,
    [userId]
  )
  return rows.map((row) => ({
    id: row.id,
    kind: 'reminder',
    kindLabel: '到期提醒',
    title: row.title || '未命名备忘录',
    snippet: `截止时间：${new Date(row.due_at_snapshot).toISOString()}`,
    href: `/whisper?note=${encodeURIComponent(row.note_id)}`,
    matchReasons: [row.number_id ? `备忘录 #${row.number_id}` : '未读到期提醒']
  }))
}

async function collectAssistantSources(userId, question, logger) {
  const [workspace, emails, reminders] = await Promise.all([
    searchWorkspaceHybridForUser({
      userId,
      search: question,
      limit: 8,
      poolInstance: pool,
      queryFn: query,
      logger
    }),
    searchEmailSources(userId, question, { limit: 5 }),
    reminderSourcesForUser(userId, question)
  ])
  const workspaceResults = workspace.results || []
  return buildAssistantSources([
    ...workspaceResults.slice(0, 4),
    ...emails.slice(0, 3),
    ...reminders.slice(0, 3),
    ...workspaceResults.slice(4),
    ...emails.slice(3),
    ...reminders.slice(3)
  ])
}

async function resolveAssistantProvider(userId, preferences) {
  const appConfig = await getUserSettingValue(userId, 'appConfig', {})
  const providerConfig = appConfig?.search?.providers?.chatgpt || {}
  const resolution = applyAssistantPreferences(
    await resolveChatProviderModel(providerConfig, { discoverPinned: true }),
    preferences
  )
  return {
    providerConfig,
    provider: resolution.provider,
    catalog: resolution.catalog
  }
}

function safetyIdentifier(userId) {
  return createHash('sha256')
    .update(`domo-nav-assistant:${userId}`)
    .digest('hex')
}

async function runAssistantModel(provider, question, sources, userId, history = []) {
  const prompts = buildAssistantPrompts(question, sources, { history })
  const chatRequest = buildChatRequest(
    { ...provider, webSearchEnabled: false },
    prompts.userInput,
    prompts.systemPrompt,
    safetyIdentifier(userId)
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

    const answer = extractAiText(payload).slice(0, MAX_ASSISTANT_ANSWER_LENGTH).trim()
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

function parseStreamPayload(payload, eventName) {
  if (!payload || payload === '[DONE]') return { done: payload === '[DONE]' }
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return {}
  }

  const type = parsed.type || eventName
  if (type === 'response.output_text.delta') {
    return { delta: String(parsed.delta || '') }
  }
  if (type === 'response.completed') {
    return {
      done: true,
      usage: parsed.response?.usage || parsed.usage || null,
      model: parsed.response?.model || parsed.model || ''
    }
  }
  if (type === 'error' || type === 'response.failed') {
    throw new Error(extractErrorMessage(parsed, '个人助理流式请求失败'))
  }

  const choice = parsed.choices?.[0]
  const content = choice?.delta?.content
  return {
    delta: typeof content === 'string' ? content : '',
    done: choice?.finish_reason != null,
    usage: parsed.usage || null,
    model: parsed.model || ''
  }
}

async function streamAssistantModel(provider, question, sources, userId, history, onDelta, externalSignal) {
  const prompts = buildAssistantPrompts(question, sources, { history })
  const chatRequest = buildChatRequest(
    { ...provider, webSearchEnabled: false },
    prompts.userInput,
    prompts.systemPrompt,
    safetyIdentifier(userId)
  )
  const body = { ...chatRequest.body, stream: true }
  if (chatRequest.apiMode === 'chat-completions') {
    body.stream_options = { include_usage: true }
  }
  await assertSafeOutboundEndpoint(chatRequest.endpoint)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abortFromCaller = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const response = await fetch(chatRequest.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${normalizeText(provider.apiKey)}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error'
    })
    if (!response.ok || !response.body) {
      const contentType = response.headers.get('content-type') || ''
      const payload = contentType.includes('application/json')
        ? await response.json()
        : await response.text()
      throw new Error(extractErrorMessage(payload, '个人助理流式请求失败'))
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let usage = null
    let responseModel = chatRequest.model

    const consumeFrame = (frame) => {
      let eventName = ''
      const dataLines = []
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (!dataLines.length) return
      const item = parseStreamPayload(dataLines.join('\n'), eventName)
      if (item.usage) usage = item.usage
      if (item.model) responseModel = item.model
      if (item.delta && answer.length < MAX_ASSISTANT_ANSWER_LENGTH) {
        const delta = item.delta.slice(0, MAX_ASSISTANT_ANSWER_LENGTH - answer.length)
        answer += delta
        onDelta(delta)
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) consumeFrame(frame)
      if (done) break
    }
    if (buffer.trim()) consumeFrame(buffer)
    if (!answer.trim()) throw new Error('个人助理没有返回可解析的回答')
    return {
      answer: answer.trim(),
      model: responseModel,
      apiMode: chatRequest.apiMode,
      usage
    }
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromCaller)
  }
}

function writeSse(raw, event, payload) {
  if (raw.destroyed || raw.writableEnded) return false
  raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  return true
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

async function recordRetrievalUsage(userId, startedAt, logger) {
  await recordRuntimeAiUsageSafely({
    userId,
    feature: AI_USAGE_FEATURES.ASSISTANT,
    provider: 'retrieval',
    model: 'none',
    apiMode: 'retrieval',
    success: true,
    usage: null,
    latencyMs: Math.max(0, Date.now() - startedAt)
  }, logger)
}

export default async function assistantRoutes(fastify) {
  fastify.get('/assistant/conversations', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const search = normalizeText(request.query?.search).slice(0, 160)
    const limit = boundedInteger(request.query?.limit, 40, 1, 100)
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`
    const { rows } = await query(
      `SELECT conversation.*,
              (SELECT message.content FROM assistant_messages AS message
               WHERE message.conversation_id = conversation.id
               ORDER BY message.created_at DESC, message.id DESC LIMIT 1) AS preview,
              (SELECT COUNT(*) FROM assistant_messages AS message
               WHERE message.conversation_id = conversation.id) AS message_count
       FROM assistant_conversations AS conversation
       WHERE conversation.user_id = $1
         AND ($2 = '' OR conversation.title ILIKE $3 ESCAPE '\\'
              OR EXISTS (
                SELECT 1 FROM assistant_messages AS message
                WHERE message.conversation_id = conversation.id
                  AND message.content ILIKE $3 ESCAPE '\\'
              ))
       ORDER BY conversation.updated_at DESC, conversation.id DESC
       LIMIT $4`,
      [request.currentUser.id, search, pattern, limit]
    )
    return { conversations: rows.map(mapConversation) }
  })

  fastify.post('/assistant/conversations', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    let preferences
    try {
      preferences = normalizeAssistantPreferences(request.body || {})
      await resolveAssistantProvider(request.currentUser.id, preferences)
    } catch (error) {
      reply.code(error instanceof AssistantPreferenceError ? 400 : 503)
      return {
        error: error instanceof AssistantPreferenceError
          ? error.message
          : 'AI 模型目录暂时不可用，请稍后重试'
      }
    }
    const conversation = await createConversation(
      { query },
      request.currentUser.id,
      request.body?.title,
      preferences
    )
    reply.code(201)
    return { conversation: mapConversation(conversation) }
  })

  fastify.patch('/assistant/conversations/:conversationId/preferences', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!isUuid(request.params.conversationId)) {
      reply.code(400)
      return { error: '对话 ID 格式无效' }
    }
    const conversation = await findConversation(
      { query },
      request.currentUser.id,
      request.params.conversationId
    )
    if (!conversation) {
      reply.code(404)
      return { error: '对话不存在' }
    }

    let preferences
    try {
      preferences = normalizeAssistantPreferences(
        request.body || {},
        conversationPreferenceFallback(conversation)
      )
      await resolveAssistantProvider(request.currentUser.id, preferences)
    } catch (error) {
      reply.code(error instanceof AssistantPreferenceError ? 400 : 503)
      return {
        error: error instanceof AssistantPreferenceError
          ? error.message
          : 'AI 模型目录暂时不可用，请稍后重试'
      }
    }

    const { rows } = await query(
      `UPDATE assistant_conversations
       SET model_mode = $3, model = $4, reasoning_effort = $5, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        conversation.id,
        request.currentUser.id,
        preferences.modelMode,
        preferences.model,
        preferences.reasoningEffort
      ]
    )
    return { conversation: mapConversation(rows[0]) }
  })

  fastify.get('/assistant/conversations/:conversationId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    if (!isUuid(request.params.conversationId)) {
      reply.code(400)
      return { error: '对话 ID 格式无效' }
    }
    const conversation = await findConversation(
      { query },
      request.currentUser.id,
      request.params.conversationId
    )
    if (!conversation) {
      reply.code(404)
      return { error: '对话不存在' }
    }
    const { rows } = await query(
      `SELECT * FROM assistant_messages
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY created_at ASC, id ASC`,
      [request.currentUser.id, conversation.id]
    )
    return {
      conversation: mapConversation(conversation),
      messages: await Promise.all(rows.map((row) => mapStoredMessage(
        row,
        request.currentUser.id
      )))
    }
  })

  fastify.delete('/assistant/conversations/:conversationId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!isUuid(request.params.conversationId)) {
      reply.code(400)
      return { error: '对话 ID 格式无效' }
    }
    const result = await query(
      `DELETE FROM assistant_conversations WHERE id = $1 AND user_id = $2`,
      [request.params.conversationId, request.currentUser.id]
    )
    if (!result.rowCount) {
      reply.code(404)
      return { error: '对话不存在' }
    }
    reply.code(204)
    return reply.send()
  })

  fastify.post('/assistant/chat/stream', async (request, reply) => {
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
    const safeQuestionForHistory = redactAssistantContext(question).trim() || '已隐去敏感内容的问题'
    const requestedConversationId = normalizeText(request.body?.conversationId)
    if (requestedConversationId && !isUuid(requestedConversationId)) {
      reply.code(400)
      return { error: '对话 ID 格式无效' }
    }

    const existingConversation = requestedConversationId
      ? await findConversation({ query }, request.currentUser.id, requestedConversationId)
      : null
    if (requestedConversationId && !existingConversation) {
      reply.code(404)
      return { error: '对话不存在' }
    }

    let preferences
    let providerResolution
    try {
      preferences = normalizeAssistantPreferences(
        request.body || {},
        conversationPreferenceFallback(existingConversation)
      )
      providerResolution = await resolveAssistantProvider(
        request.currentUser.id,
        preferences
      )
    } catch (error) {
      reply.code(error instanceof AssistantPreferenceError ? 400 : 503)
      return {
        error: error instanceof AssistantPreferenceError
          ? error.message
          : 'AI 模型目录暂时不可用，请检查服务端配置后重试'
      }
    }

    const startedAt = Date.now()
    const sources = await collectAssistantSources(
      request.currentUser.id,
      question,
      request.log
    )
    const persisted = await withTransaction(async (client) => {
      let conversation = requestedConversationId
        ? await findConversation(client, request.currentUser.id, requestedConversationId)
        : null
      if (requestedConversationId && !conversation) return null
      if (!conversation) {
        conversation = await createConversation(
          client,
          request.currentUser.id,
          safeQuestionForHistory,
          preferences
        )
      } else {
        const { rows } = await client.query(
          `UPDATE assistant_conversations
           SET model_mode = $2, model = $3, reasoning_effort = $4, updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            conversation.id,
            preferences.modelMode,
            preferences.model,
            preferences.reasoningEffort
          ]
        )
        conversation = rows[0]
      }
      const history = await recentConversationHistory(
        client,
        request.currentUser.id,
        conversation.id
      )
      const { rows } = await client.query(
        `INSERT INTO assistant_messages (conversation_id, user_id, role, content)
         VALUES ($1, $2, 'user', $3) RETURNING *`,
        [conversation.id, request.currentUser.id, safeQuestionForHistory]
      )
      await client.query(
        `UPDATE assistant_conversations SET updated_at = NOW() WHERE id = $1`,
        [conversation.id]
      )
      return { conversation, history, userMessage: rows[0] }
    })
    if (!persisted) {
      reply.code(404)
      return { error: '对话不存在' }
    }

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    reply.raw.setHeader('Cache-Control', 'private, no-store, no-transform')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.flushHeaders?.()
    writeSse(reply.raw, 'conversation', {
      conversation: mapConversation(persisted.conversation),
      userMessage: mapMessage(persisted.userMessage)
    })
    writeSse(reply.raw, 'sources', { sources })

    let result = null
    let providerName = 'retrieval'
    const clientAbort = new AbortController()
    const abortOnDisconnect = () => clientAbort.abort()
    reply.raw.once('close', abortOnDisconnect)
    try {
      const { provider, providerConfig } = providerResolution
      if (!provider?.enabled || !normalizeText(provider.apiKey)) {
        const fallback = retrievalResponse(
          question,
          sources,
          'not-configured'
        )
        writeSse(reply.raw, 'delta', { delta: fallback.answer })
        result = {
          answer: fallback.answer,
          model: '',
          apiMode: 'retrieval',
          usage: null,
          degradedReason: fallback.degradedReason
        }
        await recordRetrievalUsage(request.currentUser.id, startedAt, request.log)
      } else {
        providerName = 'chatgpt'
        try {
          result = await streamAssistantModel(
            provider,
            question,
            sources,
            request.currentUser.id,
            persisted.history,
            (delta) => writeSse(reply.raw, 'delta', { delta }),
            clientAbort.signal
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
        } catch (error) {
          if (clientAbort.signal.aborted) throw error
          await recordRuntimeAiUsageSafely({
            userId: request.currentUser.id,
            feature: AI_USAGE_FEATURES.ASSISTANT,
            provider: 'chatgpt',
            model: provider?.model || providerConfig?.model || 'unknown',
            apiMode: provider?.apiMode || providerConfig?.apiMode || 'unknown',
            success: false,
            usage: null,
            latencyMs: Math.max(0, Date.now() - startedAt)
          }, request.log)
          const fallback = buildRetrievalFallbackAnswer(sources)
          writeSse(reply.raw, 'reset', { content: fallback, degradedReason: 'provider-unavailable' })
          providerName = 'retrieval'
          result = {
            answer: fallback,
            model: '',
            apiMode: 'retrieval',
            usage: null,
            degradedReason: 'provider-unavailable'
          }
          request.log?.warn?.(
            { errorCode: String(error?.code || error?.name || 'ASSISTANT_STREAM_ERROR').slice(0, 64) },
            'personal assistant stream degraded to retrieval'
          )
        }
      }

      const storage = await prepareAssistantAnswerForStorage({
        answer: result.answer,
        sources,
        userId: request.currentUser.id,
        conversationId: persisted.conversation.id,
        logger: request.log
      })
      const assistantMessage = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO assistant_messages (
             conversation_id, user_id, role, content, content_encrypted,
             content_sensitive, sources, provider, model
           ) VALUES ($1, $2, 'assistant', $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING *`,
          [
            persisted.conversation.id,
            request.currentUser.id,
            storage.content,
            storage.contentEncrypted,
            storage.contentSensitive,
            JSON.stringify(storage.sources),
            providerName,
            result.model || null
          ]
        )
        await client.query(
          `UPDATE assistant_conversations SET updated_at = NOW() WHERE id = $1`,
          [persisted.conversation.id]
        )
        return rows[0]
      })
      writeSse(reply.raw, 'done', {
        message: mapMessage(assistantMessage, {
          content: result.answer,
          sources
        }),
        degradedReason: result.degradedReason || ''
      })
    } catch (error) {
      if (!clientAbort.signal.aborted) {
        request.log.error(error)
        writeSse(reply.raw, 'error', { error: '个人助理暂时不可用，请稍后重试' })
      }
    } finally {
      reply.raw.off('close', abortOnDisconnect)
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end()
    }
  })

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

    const startedAt = Date.now()
    const sources = await collectAssistantSources(
      request.currentUser.id,
      question,
      request.log
    )
    let provider = null
    let providerConfig = {}
    try {
      ;({ provider, providerConfig } = await resolveAssistantProvider(request.currentUser.id))
      if (!provider?.enabled || !normalizeText(provider.apiKey)) {
        await recordRetrievalUsage(request.currentUser.id, startedAt, request.log)
        return retrievalResponse(question, sources, 'not-configured')
      }
      const result = await runAssistantModel(
        provider,
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
        mode: sources.length ? 'answer' : 'general',
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
        model: provider?.model || providerConfig?.model || 'unknown',
        apiMode: provider?.apiMode || providerConfig?.apiMode || 'unknown',
        success: false,
        usage: null,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }, request.log)
      return retrievalResponse(question, sources, 'provider-unavailable')
    }
  })
}
