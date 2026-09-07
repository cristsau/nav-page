import { query } from '../db/index.js'
import { ACTIVE_NOTIFICATION_SQL } from '../lib/mailboxRetirement.js'
import { mapNotification } from '../lib/notifications.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function boundedLimit(value, fallback = 40) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback
}

export default async function notificationRoutes(fastify) {
  fastify.get('/notifications', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const limit = boundedLimit(request.query?.limit)
    const unreadOnly = String(request.query?.unreadOnly || '') === 'true'
    const { rows } = await query(
      `
        SELECT *
        FROM notifications
        WHERE user_id = $1 AND ${ACTIVE_NOTIFICATION_SQL}
          AND ($2::boolean = FALSE OR read_at IS NULL)
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC, id DESC
        LIMIT $3
      `,
      [request.currentUser.id, unreadOnly, limit]
    )
    const count = await query(
      `
        SELECT COUNT(*)::integer AS count
        FROM notifications
        WHERE user_id = $1 AND ${ACTIVE_NOTIFICATION_SQL} AND read_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
      `,
      [request.currentUser.id]
    )
    return {
      notifications: rows.map((row) => mapNotification(row, null)),
      unreadCount: Number(count.rows[0]?.count || 0)
    }
  })

  fastify.get('/notifications/unread-count', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const { rows } = await query(
      `SELECT COUNT(*)::integer AS count FROM notifications
       WHERE user_id = $1 AND ${ACTIVE_NOTIFICATION_SQL} AND read_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [request.currentUser.id]
    )
    return { unreadCount: Number(rows[0]?.count || 0) }
  })

  fastify.patch('/notifications/:notificationId/read', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const id = String(request.params.notificationId || '')
    if (!UUID_PATTERN.test(id)) {
      reply.code(400)
      return { error: 'Invalid notification id' }
    }
    const result = await query(
      `UPDATE notifications SET read_at = COALESCE(read_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [id, request.currentUser.id]
    )
    if (!result.rowCount) {
      reply.code(404)
      return { error: 'Notification not found' }
    }
    return { ok: true }
  })

  fastify.post('/notifications/read-all', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const result = await query(
      `UPDATE notifications SET read_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND ${ACTIVE_NOTIFICATION_SQL} AND read_at IS NULL`,
      [request.currentUser.id]
    )
    return { ok: true, updatedCount: result.rowCount }
  })

  fastify.delete('/notifications/:notificationId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const id = String(request.params.notificationId || '')
    if (!UUID_PATTERN.test(id)) {
      reply.code(400)
      return { error: 'Invalid notification id' }
    }
    const result = await query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [id, request.currentUser.id]
    )
    if (!result.rowCount) {
      reply.code(404)
      return { error: 'Notification not found' }
    }
    return { ok: true }
  })
}
