import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import { verifyPassword } from '../lib/auth.js'
import { validateSecurityEventDeletion } from '../lib/securityEventDeletion.js'
import {
  SECURITY_EVENT_EXPORT_MAX_ROWS,
  normalizeSecurityEventExportFormat,
  securityEventExportFilename,
  serializeSecurityEventExport
} from '../lib/securityEventExport.js'
import {
  recordSecurityEvent,
  recordSecurityEventBestEffort,
  SECURITY_EVENT_OUTCOMES,
  SECURITY_EVENT_TYPES
} from '../lib/securityEvents.js'

const EVENT_TYPES = new Set(SECURITY_EVENT_TYPES)
const EVENT_OUTCOMES = new Set(SECURITY_EVENT_OUTCOMES)
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const MAX_PAGE = 1_000_000

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, maximum)
}

function normalizeFilter(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function validateSecurityEventQuery(value = {}) {
  const page = positiveInteger(value?.page, 1, MAX_PAGE)
  const pageSize = positiveInteger(
    value?.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  )
  const eventType = normalizeFilter(value?.eventType)
  const outcome = normalizeFilter(value?.outcome)

  if (eventType && !EVENT_TYPES.has(eventType)) {
    return {
      valid: false,
      error: 'Unsupported security event type'
    }
  }
  if (outcome && !EVENT_OUTCOMES.has(outcome)) {
    return {
      valid: false,
      error: 'Unsupported security event outcome'
    }
  }

  return {
    valid: true,
    page,
    pageSize,
    eventType,
    outcome
  }
}

export function mapSecurityEvent(row) {
  return {
    id: String(row.id),
    eventType: row.event_type,
    outcome: row.outcome,
    actorUserId: row.actor_user_id || null,
    subjectUserId: row.subject_user_id || null,
    resourceType: row.resource_type || null,
    resourceId: row.resource_id || null,
    affectedCount: row.affected_count === null
      ? null
      : Number(row.affected_count),
    clientFingerprint: String(row.client_ip_digest || '').slice(0, 16) || null,
    userAgentFingerprint: String(row.user_agent_digest || '').slice(0, 16) || null,
    createdAt: row.created_at
  }
}

function buildSecurityEventFilter(eventType, outcome) {
  const conditions = []
  const params = []
  if (eventType) {
    params.push(eventType)
    conditions.push(`event_type = $${params.length}`)
  }
  if (outcome) {
    params.push(outcome)
    conditions.push(`outcome = $${params.length}`)
  }
  return {
    params,
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  }
}

function securityEventRetentionPolicy() {
  return {
    enabled: config.securityEventRetentionEnabled,
    routineDays: config.securityEventRoutineRetentionDays,
    deniedDays: config.securityEventDeniedRetentionDays,
    criticalDays: config.securityEventCriticalRetentionDays,
    intervalSeconds: config.securityEventRetentionIntervalSeconds,
    batchSize: config.securityEventRetentionBatchSize,
    maxBatchesPerRun: config.securityEventRetentionMaxBatchesPerRun
  }
}

export default async function securityEventRoutes(fastify, options = {}) {
  const queryFn = typeof options.queryFn === 'function'
    ? options.queryFn
    : query
  const transactionFn = typeof options.transactionFn === 'function'
    ? options.transactionFn
    : withTransaction
  const auditBestEffortFn = typeof options.auditBestEffortFn === 'function'
    ? options.auditBestEffortFn
    : recordSecurityEventBestEffort

  fastify.get('/admin/security-events/export', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAdmin(request, reply)

    const format = normalizeSecurityEventExportFormat(request.query?.format)
    if (!format) {
      reply.code(400)
      return { error: 'format must be csv or json' }
    }

    const filters = validateSecurityEventQuery(request.query)
    if (!filters.valid) {
      reply.code(400)
      return { error: filters.error }
    }
    const filterQuery = buildSecurityEventFilter(filters.eventType, filters.outcome)
    const exportLimit = SECURITY_EVENT_EXPORT_MAX_ROWS + 1
    const limitParameter = `$${filterQuery.params.length + 1}`
    const { rows } = await queryFn(
      `
        SELECT
          id,
          event_type,
          outcome,
          actor_user_id,
          subject_user_id,
          resource_type,
          resource_id,
          affected_count,
          client_ip_digest,
          user_agent_digest,
          created_at
        FROM security_events
        ${filterQuery.whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitParameter}
      `,
      [...filterQuery.params, exportLimit]
    )
    const truncated = rows.length > SECURITY_EVENT_EXPORT_MAX_ROWS
    const events = rows
      .slice(0, SECURITY_EVENT_EXPORT_MAX_ROWS)
      .map(mapSecurityEvent)
    const generatedAt = new Date()
    const serialized = serializeSecurityEventExport({
      events,
      format,
      generatedAt,
      truncated,
      filters: {
        eventType: filters.eventType,
        outcome: filters.outcome
      }
    })

    await auditBestEffortFn({
      request,
      eventType: 'admin.security_events.export',
      outcome: 'success',
      actorUserId: request.currentUser.id,
      subjectUserId: request.currentUser.id,
      resourceType: 'security_event',
      affectedCount: events.length
    }, request.log)

    reply
      .header('Content-Disposition', `attachment; filename="${securityEventExportFilename(format, generatedAt)}"`)
      .header('X-NAV-Export-Count', String(events.length))
      .header('X-NAV-Export-Truncated', String(truncated))
      .type(serialized.contentType)
    return reply.send(Buffer.from(serialized.body, 'utf8'))
  })

  fastify.get('/admin/security-events', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAdmin(request, reply)

    const filters = validateSecurityEventQuery(request.query)
    if (!filters.valid) {
      reply.code(400)
      return { error: filters.error }
    }
    const { page, pageSize, eventType, outcome } = filters

    const filterQuery = buildSecurityEventFilter(eventType, outcome)
    const countResult = await queryFn(
      `
        SELECT COUNT(*)::integer AS total
        FROM security_events
        ${filterQuery.whereClause}
      `,
      filterQuery.params
    )

    const rowParams = [
      ...filterQuery.params,
      pageSize,
      (page - 1) * pageSize
    ]
    const limitParameter = `$${rowParams.length - 1}`
    const offsetParameter = `$${rowParams.length}`

    const { rows } = await queryFn(
      `
        SELECT
          id,
          event_type,
          outcome,
          actor_user_id,
          subject_user_id,
          resource_type,
          resource_id,
          affected_count,
          client_ip_digest,
          user_agent_digest,
          created_at
        FROM security_events
        ${filterQuery.whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitParameter}
        OFFSET ${offsetParameter}
      `,
      rowParams
    )

    return {
      events: rows.map(mapSecurityEvent),
      pagination: {
        page,
        pageSize,
        total: Number(countResult.rows[0]?.total || 0)
      },
      filters: {
        eventTypes: SECURITY_EVENT_TYPES,
        outcomes: SECURITY_EVENT_OUTCOMES
      },
      retention: securityEventRetentionPolicy(),
      exportLimit: SECURITY_EVENT_EXPORT_MAX_ROWS
    }
  })

  fastify.post('/admin/security-events/delete', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAdmin(request, reply)

    const deletion = validateSecurityEventDeletion(request.body)
    if (!deletion.valid) {
      reply.code(400)
      return { error: deletion.error }
    }

    const result = await transactionFn(async (client) => {
      const userResult = await client.query(
        `
          SELECT password_hash
          FROM users
          WHERE id = $1
          FOR UPDATE
        `,
        [request.currentUser.id]
      )
      const user = userResult.rows[0]
      if (!user || !await verifyPassword(deletion.currentPassword, user.password_hash)) {
        return { status: 'invalid-password' }
      }

      const deleted = await client.query(
        `
          DELETE FROM security_events
          WHERE id = ANY($1::bigint[])
          RETURNING id
        `,
        [deletion.eventIds]
      )
      const deletedCount = deleted.rowCount || 0

      await recordSecurityEvent({
        client,
        request,
        eventType: 'admin.security_events.delete',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'security_event',
        affectedCount: deletedCount
      })

      return { status: 'deleted', deletedCount }
    })

    if (result.status === 'invalid-password') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'admin.security_events.delete',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'security_event'
      }, request.log)
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }

    return {
      ok: true,
      deletedCount: result.deletedCount
    }
  })
}
