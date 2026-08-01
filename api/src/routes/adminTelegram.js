import { query, withTransaction } from '../db/index.js'
import {
  callTelegram,
  getAdminTelegramConfig,
  saveAdminTelegramConfig,
  syncTelegramApprovalsForAdmin,
  testAdminTelegramConfig,
  sendDecisionNotificationToAdmins
} from '../lib/telegram.js'
import {
  recordSecurityEvent
} from '../lib/securityEvents.js'
import { mapRegistrationRequest } from '../lib/users.js'

async function approveRegistrationRequest(requestId, decidedBy, eventRequest) {
  return withTransaction(async (client) => {
    const requestResult = await client.query(
      'SELECT * FROM registration_requests WHERE id = $1 LIMIT 1 FOR UPDATE',
      [requestId]
    )

    const registration = requestResult.rows[0]
    if (!registration) {
      return null
    }

    if (registration.status !== 'pending') {
      return registration
    }

    const existingUser = await client.query(
      'SELECT id FROM users WHERE username = $1 LIMIT 1',
      [registration.username]
    )
    let subjectUserId = existingUser.rows[0]?.id || null

    if (existingUser.rowCount === 0) {
      const createdUser = await client.query(
        `
          INSERT INTO users (
            username,
            password_hash,
            role,
            status,
            approved_at
          ) VALUES ($1, $2, 'user', 'approved', NOW())
          RETURNING id
        `,
        [registration.username, registration.password_hash]
      )
      subjectUserId = createdUser.rows[0].id
    }

    const approved = await client.query(
      `
        UPDATE registration_requests
        SET status = 'approved',
            updated_at = NOW(),
            decided_at = NOW(),
            decided_by = $2
        WHERE id = $1
        RETURNING *
      `,
      [requestId, decidedBy]
    )

    await recordSecurityEvent({
      client,
      request: eventRequest,
      eventType: 'admin.registration.approve',
      outcome: 'success',
      actorUserId: decidedBy,
      subjectUserId,
      resourceType: 'registration_request',
      resourceId: requestId,
      affectedCount: 1
    })

    return approved.rows[0]
  })
}

async function rejectRegistrationRequest(requestId, decidedBy, eventRequest) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `
        UPDATE registration_requests
        SET status = 'rejected',
            updated_at = NOW(),
            decided_at = NOW(),
            decided_by = $2
        WHERE id = $1
          AND status = 'pending'
        RETURNING *
      `,
      [requestId, decidedBy]
    )
    const rejected = result.rows[0]
    if (!rejected) return null

    await recordSecurityEvent({
      client,
      request: eventRequest,
      eventType: 'admin.registration.reject',
      outcome: 'success',
      actorUserId: decidedBy,
      resourceType: 'registration_request',
      resourceId: requestId,
      affectedCount: 1
    })
    return rejected
  })
}

async function findRegistrationRequest(requestId) {
  const result = await query(
    'SELECT * FROM registration_requests WHERE id = $1 LIMIT 1',
    [requestId]
  )
  return result.rows[0] || null
}

export default async function adminTelegramRoutes(fastify) {
  fastify.get('/admin/telegram-config', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const config = await getAdminTelegramConfig(request.currentUser.id)
    return { config }
  })

  fastify.put('/admin/telegram-config', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const saved = await withTransaction(async (client) => {
      const config = await saveAdminTelegramConfig(
        request.currentUser.id,
        request.body || {},
        { client }
      )
      await recordSecurityEvent({
        client,
        request,
        eventType: 'admin.telegram_config.update',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'telegram_config',
        affectedCount: 1
      })
      return config
    })
    return saved
  })

  fastify.post('/admin/telegram-config/test', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const result = await testAdminTelegramConfig(request.body || {})
    return result
  })

  fastify.post('/admin/telegram/sync', async (request, reply) => {
    await fastify.requireAdmin(request, reply)

    const summary = await syncTelegramApprovalsForAdmin({
      adminUserId: request.currentUser.id,
      onFindRequest: findRegistrationRequest,
      onApprove: async (requestId) => {
        const approved = await approveRegistrationRequest(
          requestId,
          request.currentUser.id,
          request
        )
        if (approved) {
          await sendDecisionNotificationToAdmins(approved, '批准')
        }
      },
      onReject: async (requestId) => {
        const rejected = await rejectRegistrationRequest(
          requestId,
          request.currentUser.id,
          request
        )
        if (rejected) {
          await sendDecisionNotificationToAdmins(rejected, '拒绝')
        }
      }
    })

    return summary
  })

  // Compatibility routes for older production bundles that still call the
  // previous Vite proxy endpoints. They remain admin-only and simply proxy to
  // Telegram using the provided bot token.
  fastify.post('/telegram/get-me', async (request, reply) => {
    await fastify.requireAdmin(request, reply)

    const botToken = String(request.body?.botToken || '').trim()
    if (!botToken) {
      throw new Error('Bot Token is required')
    }

    return callTelegram(botToken, 'getMe')
  })

  fastify.post('/telegram/get-updates', async (request, reply) => {
    await fastify.requireAdmin(request, reply)

    const botToken = String(request.body?.botToken || '').trim()
    if (!botToken) {
      throw new Error('Bot Token is required')
    }

    return callTelegram(botToken, 'getUpdates', {
      offset: request.body?.offset,
      limit: request.body?.limit
    })
  })

  fastify.post('/telegram/send-message', async (request, reply) => {
    await fastify.requireAdmin(request, reply)

    const botToken = String(request.body?.botToken || '').trim()
    const chatId = String(request.body?.chatId || '').trim()
    const text = String(request.body?.text || '').trim()

    if (!botToken || !chatId || !text) {
      throw new Error('Bot Token, Chat ID and text are required')
    }

    return callTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text
    })
  })
}
