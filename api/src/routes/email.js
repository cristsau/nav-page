import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { query } from '../db/index.js'
import { loadEmailEncryptionKey } from '../lib/emailCrypto.js'
import { getEmailEventForUser, getEmailNotificationDetails } from '../lib/emailEvents.js'
import { validateImapConfig } from '../lib/emailIngestScheduler.js'
import {
  enqueueMail,
  normalizeEmailAddress,
  verifiedMailConfigurationStatus
} from '../lib/mailOutbox.js'
import { readOwnerSecretFile } from '../lib/ownerSecretFile.js'
import { recordSecurityEventBestEffort } from '../lib/securityEvents.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function boundedLimit(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 40
}

async function emailFeatureStatus({ includeTransportDetails = false } = {}) {
  let encryptionConfigured = false
  let imapConfigured = false
  try {
    const key = await loadEmailEncryptionKey(config, { bypassCache: true })
    key.fill(0)
    encryptionConfigured = true
  } catch {}
  try {
    validateImapConfig(config)
    await readOwnerSecretFile(config.imapPasswordFile, { label: 'IMAP password', maxBytes: 4096 })
    imapConfigured = true
  } catch {}
  const mailStatus = await verifiedMailConfigurationStatus()
  return {
    mail: includeTransportDetails
      ? mailStatus
      : {
          configured: mailStatus.configured,
          enabled: mailStatus.enabled,
          transport: mailStatus.transport
        },
    ingest: {
      enabled: config.emailIngestEnabled,
      configured: imapConfigured && encryptionConfigured,
      source: 'imap-tls',
      idle: true
    },
    digest: {
      enabled: config.emailDigestEnabled,
      hours: config.emailDigestHours,
      timeZone: config.emailDigestTimeZone
    },
    encryptionConfigured
  }
}

export default async function emailRoutes(fastify) {
  fastify.get('/email/status', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const status = await emailFeatureStatus()
    const state = await query(
      `SELECT source_key, last_connected_at, last_message_at, last_error_at, last_error_code
       FROM email_mailbox_state WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [request.currentUser.id]
    )
    return { ...status, mailbox: state.rows[0] || null }
  })

  fastify.get('/email/events', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const tier = Number(request.query?.tier || 0)
    if (tier && ![1, 2, 3].includes(tier)) {
      reply.code(400)
      return { error: 'Email tier is invalid' }
    }
    const limit = boundedLimit(request.query?.limit)
    const { rows } = await query(
      `SELECT id, tier, received_at
       FROM email_events
       WHERE user_id = $1 AND ($2::integer = 0 OR tier = $2)
       ORDER BY received_at DESC, id DESC LIMIT $3`,
      [request.currentUser.id, tier, limit]
    )
    const details = await getEmailNotificationDetails(
      request.currentUser.id,
      rows.map((row) => row.id)
    )
    return { emails: rows.map((row) => details.get(String(row.id))).filter(Boolean) }
  })

  fastify.get('/email/events/:emailEventId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const id = String(request.params.emailEventId || '')
    if (!UUID_PATTERN.test(id)) {
      reply.code(400)
      return { error: 'Invalid email event id' }
    }
    const email = await getEmailEventForUser(request.currentUser.id, id)
    if (!email) {
      reply.code(404)
      return { error: 'Email event not found' }
    }
    return { email }
  })

  fastify.get('/admin/mail/status', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    return emailFeatureStatus({ includeTransportDetails: true })
  })

  fastify.post('/admin/mail/test', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')

    const mailStatus = await verifiedMailConfigurationStatus()
    if (!mailStatus.configured || !mailStatus.enabled) {
      reply.code(503)
      return { error: 'Mail delivery is not configured and enabled' }
    }

    let recipient
    try {
      recipient = normalizeEmailAddress(request.body?.recipient)
    } catch (error) {
      reply.code(400)
      return { error: error.message }
    }

    const origin = String(config.publicAppOrigin || 'https://nav.skrskr.net').replace(/\/$/, '')
    const queued = await enqueueMail({
      messageType: 'system.test',
      recipient,
      subject: 'DOMO NAV 邮件通道测试',
      textBody: `这是 DOMO NAV 的 SMTP 通道测试邮件。\n\n收到这封邮件说明发件队列与 SMTP 通道工作正常。\n${origin}`,
      htmlBody: `<p>这是 DOMO NAV 的 SMTP 通道测试邮件。</p><p>收到这封邮件说明发件队列与 SMTP 通道工作正常。</p><p><a href="${origin}">打开 DOMO NAV</a></p>`,
      dedupeKey: `system-test:${request.currentUser.id}:${randomUUID()}`,
      sensitive: true
    })

    await recordSecurityEventBestEffort({
      request,
      eventType: 'admin.mail.test',
      outcome: 'success',
      actorUserId: request.currentUser.id,
      subjectUserId: request.currentUser.id,
      resourceType: 'mail_outbox',
      resourceId: queued.id,
      affectedCount: 1
    }, request.log)

    reply.code(202)
    return { queued: true, id: queued.id, status: queued.status }
  })
}
