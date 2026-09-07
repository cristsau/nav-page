import { query } from '../db/index.js'
import { digestSensitiveValue } from './persistentRateLimit.js'

export const SECURITY_EVENT_TYPES = Object.freeze([
  'auth.login',
  'auth.email.login',
  'auth.password.reset',
  'auth.account.email.bind',
  'auth.account.email.change',
  'auth.logout',
  'auth.recovery',
  'auth.recovery_codes.rotate',
  'auth.session.revoke',
  'auth.passkey.register',
  'auth.passkey.login',
  'auth.passkey.delete',
  'auth.oauth.login',
  'auth.oauth.link',
  'auth.oauth.unlink',
  'auth.account.username.update',
  'auth.account.password.update',
  'account.data.restore',
  'admin.registration.approve',
  'admin.registration.reject',
  'admin.mail.test',
  'admin.integrations.mail.updated',
  'admin.integrations.mail.smtp_tested',
  'admin.integrations.mail.imap_tested',
  'admin.integrations.cloud_backup.updated',
  'admin.integrations.cloud_backup.tested',
  'admin.integrations.oauth.updated',
  'admin.integrations.oauth.tested',
  'admin.integrations.email_oauth.updated',
  'admin.integrations.email_oauth.tested',
  'email.ai.request',
  'email.ai.proposal.confirm',
  'email.remote_command.queued',
  'email.remote_command.cancelled',
  'email.remote_command.executed',
  'email.remote_command.failed',
  'email.remote_command.conflict',
  'email.notification_rule.create',
  'email.notification_rule.update',
  'email.notification_rule.delete',
  'email.notification_rule.preview',
  'admin.telegram_config.update',
  'admin.security_events.export',
  'admin.security_events.delete'
])

export const SECURITY_EVENT_OUTCOMES = Object.freeze([
  'success',
  'failure',
  'denied'
])

const EVENT_TYPES = new Set(SECURITY_EVENT_TYPES)
const EVENT_OUTCOMES = new Set(SECURITY_EVENT_OUTCOMES)
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/

function normalizeText(value) {
  return String(value ?? '').trim()
}

function normalizeOptionalText(value) {
  const normalized = normalizeText(value).toLowerCase()
  return normalized || null
}

function normalizeAffectedCount(value) {
  if (value === undefined || value === null) return null

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('affectedCount must be a non-negative integer')
  }
  return parsed
}

function buildRequestFingerprints(request, { secret } = {}) {
  const clientIp = normalizeText(
    request?.ip
    || request?.socket?.remoteAddress
    || request?.raw?.socket?.remoteAddress
  )
  const userAgent = normalizeText(request?.headers?.['user-agent'])

  return {
    clientIpDigest: clientIp
      ? digestSensitiveValue('security-event:client-ip', clientIp, { secret })
      : null,
    userAgentDigest: userAgent
      ? digestSensitiveValue('security-event:user-agent', userAgent, { secret })
      : null
  }
}

export async function recordSecurityEvent({
  client,
  request,
  eventType,
  outcome,
  actorUserId = null,
  subjectUserId = null,
  resourceType = null,
  resourceId = null,
  affectedCount = null,
  fingerprintSecret
}) {
  const normalizedEventType = normalizeText(eventType).toLowerCase()
  const normalizedOutcome = normalizeText(outcome).toLowerCase()
  const normalizedResourceType = normalizeOptionalText(resourceType)

  if (!EVENT_TYPES.has(normalizedEventType)) {
    throw new TypeError('Unsupported security event type')
  }
  if (!EVENT_OUTCOMES.has(normalizedOutcome)) {
    throw new TypeError('Unsupported security event outcome')
  }
  if (
    normalizedResourceType
    && !RESOURCE_TYPE_PATTERN.test(normalizedResourceType)
  ) {
    throw new TypeError('Invalid security event resource type')
  }

  const fingerprints = buildRequestFingerprints(request, {
    secret: fingerprintSecret
  })
  const queryFn = client?.query
    ? client.query.bind(client)
    : query

  const result = await queryFn(
    `
      INSERT INTO security_events (
        event_type,
        outcome,
        actor_user_id,
        subject_user_id,
        resource_type,
        resource_id,
        affected_count,
        client_ip_digest,
        user_agent_digest
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at
    `,
    [
      normalizedEventType,
      normalizedOutcome,
      actorUserId || null,
      subjectUserId || null,
      normalizedResourceType,
      resourceId || null,
      normalizeAffectedCount(affectedCount),
      fingerprints.clientIpDigest,
      fingerprints.userAgentDigest
    ]
  )

  return result.rows[0]
}

export async function recordSecurityEventBestEffort(options, logger) {
  try {
    await recordSecurityEvent(options)
    return true
  } catch (error) {
    logger?.error?.(error, 'failed to record security event')
    return false
  }
}
