import { query } from '../db/index.js'
import {
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

function mapSecurityEvent(row) {
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

export default async function securityEventRoutes(fastify, options = {}) {
  const queryFn = typeof options.queryFn === 'function'
    ? options.queryFn
    : query

  fastify.get('/admin/security-events', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAdmin(request, reply)

    const filters = validateSecurityEventQuery(request.query)
    if (!filters.valid) {
      reply.code(400)
      return { error: filters.error }
    }
    const { page, pageSize, eventType, outcome } = filters

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

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : ''
    const countResult = await queryFn(
      `
        SELECT COUNT(*)::integer AS total
        FROM security_events
        ${whereClause}
      `,
      params
    )

    const rowParams = [...params, pageSize, (page - 1) * pageSize]
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
        ${whereClause}
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
      }
    }
  })
}
