import { createHmac, randomUUID } from 'node:crypto'
import { domainToASCII } from 'node:url'
import { query } from '../db/index.js'
import {
  decryptEmailPayload,
  decryptEmailPayloadWithKey,
  encryptEmailPayload,
  encryptEmailPayloadWithKey,
  loadEmailEncryptionKey
} from './emailCrypto.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u

export const EMAIL_NOTIFICATION_SCOPES = Object.freeze([
  'conversation',
  'sender',
  'domain',
  'category',
  'account'
])

export const EMAIL_NOTIFICATION_ACTIONS = Object.freeze([
  'immediate',
  'digest',
  'in_app_only',
  'silent'
])

export const EMAIL_NOTIFICATION_CATEGORIES = Object.freeze([
  'security',
  'payment',
  'operations',
  'action',
  'status',
  'personal',
  'marketing',
  'social',
  'other'
])

const SCOPE_SET = new Set(EMAIL_NOTIFICATION_SCOPES)
const ACTION_SET = new Set(EMAIL_NOTIFICATION_ACTIONS)
const CATEGORY_SET = new Set(EMAIL_NOTIFICATION_CATEGORIES)
const CRITICAL_CATEGORIES = new Set(['security', 'payment'])
const SUPPRESSIVE_ACTIONS = new Set(['digest', 'in_app_only', 'silent'])
const SCOPE_PRIORITY = Object.freeze({
  account: 100,
  category: 200,
  domain: 300,
  sender: 400,
  conversation: 500
})
const ACTION_LABELS = Object.freeze({
  immediate: '立即提醒',
  digest: '仅进入邮件摘要',
  in_app_only: '仅在 DOMO NAV 站内提醒',
  silent: '静默收件'
})
const SCOPE_LABELS = Object.freeze({
  conversation: '当前会话',
  sender: '这个发件人',
  domain: '这个发件人域名',
  category: '这类邮件',
  account: '当前邮箱'
})

function normalizeText(value, maximum = 600) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function ruleContext(userId, ruleId) {
  return `email-notification-rule:${String(userId || '')}:${String(ruleId || '')}`
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) throw new TypeError('Email account id is invalid')
  return normalized
}

function normalizeDomain(value) {
  const raw = String(value || '').normalize('NFKC').trim().toLowerCase().replace(/^@+/, '')
  const ascii = domainToASCII(raw).toLowerCase()
  if (
    !ascii
    || ascii.length > 253
    || ascii.includes('..')
    || !ascii.includes('.')
    || !/^[a-z0-9.-]+$/.test(ascii)
    || ascii.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
  ) throw new TypeError('Email sender domain is invalid')
  return ascii
}

export function normalizeEmailNotificationCategory(value, fallback = 'other') {
  const normalized = String(value || '').trim().toLowerCase()
  if (CATEGORY_SET.has(normalized)) return normalized
  return CATEGORY_SET.has(fallback) ? fallback : 'other'
}

export function normalizeEmailRuleMatchValue(scopeValue, value, accountId) {
  const scope = String(scopeValue || '').trim().toLowerCase()
  if (!SCOPE_SET.has(scope)) throw new TypeError('Email notification rule scope is invalid')
  if (scope === 'account') return normalizeAccountId(accountId)
  if (scope === 'sender') {
    const sender = String(value || '').normalize('NFKC').trim().toLowerCase()
    if (sender.length > 320 || !EMAIL_PATTERN.test(sender)) {
      throw new TypeError('Email sender address is invalid')
    }
    return sender
  }
  if (scope === 'domain') return normalizeDomain(value)
  if (scope === 'category') {
    const category = String(value || '').trim().toLowerCase()
    if (!CATEGORY_SET.has(category)) throw new TypeError('Email category is invalid')
    return category
  }
  const conversation = String(value || '').trim().toLowerCase()
  if (!DIGEST_PATTERN.test(conversation)) throw new TypeError('Email conversation key is invalid')
  return conversation
}

function normalizeRuleExpiry(value, { allowPast = false } = {}) {
  if (value === undefined || value === null || value === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new TypeError('Email notification rule expiry is invalid')
  if (!allowPast && parsed.getTime() <= Date.now()) {
    throw new TypeError('Email notification rule expiry must be in the future')
  }
  return parsed.toISOString()
}

export function normalizeEmailNotificationRuleInput(payload = {}) {
  const accountId = normalizeAccountId(payload.accountId)
  const scope = String(payload.scope || '').trim().toLowerCase()
  if (!SCOPE_SET.has(scope)) throw new TypeError('Email notification rule scope is invalid')
  const action = String(payload.action || '').trim().toLowerCase()
  if (!ACTION_SET.has(action)) throw new TypeError('Email notification rule action is invalid')
  const matchValue = normalizeEmailRuleMatchValue(scope, payload.matchValue, accountId)
  return {
    accountId,
    scope,
    action,
    priority: SCOPE_PRIORITY[scope],
    matchValue,
    enabled: payload.enabled !== false,
    expiresAt: normalizeRuleExpiry(payload.expiresAt),
    criticalOverrideConfirmed: payload.criticalOverrideConfirmed === true,
    explanation: `${SCOPE_LABELS[scope]}手动规则：${ACTION_LABELS[action]}。`
  }
}

export function digestEmailNotificationRuleValue(scope, value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError('Email notification rule digest key is invalid')
  }
  return createHmac('sha256', key)
    .update(`domo-nav-email-notification-rule:v1\u0000${scope}\u0000${value}`)
    .digest('hex')
}

export function defaultEmailNotificationAction(tier) {
  if (Number(tier) === 1) return 'immediate'
  if (Number(tier) === 2) return 'digest'
  return 'silent'
}

export function emailImportanceScore(tier, urgency) {
  const normalizedUrgency = String(urgency || '').toLowerCase()
  if (Number(tier) === 1) return normalizedUrgency === 'high' ? 95 : 85
  if (Number(tier) === 2) {
    if (normalizedUrgency === 'high') return 75
    if (normalizedUrgency === 'medium') return 65
    return 55
  }
  if (normalizedUrgency === 'high') return 45
  if (normalizedUrgency === 'medium') return 35
  return 20
}

function defaultDecision(tier, { protectedRule = false } = {}) {
  const action = defaultEmailNotificationAction(tier)
  const defaultReason = Number(tier) === 1
    ? '默认策略：高风险邮件立即提醒。'
    : Number(tier) === 2
      ? '默认策略：当天处理邮件进入摘要。'
      : '默认策略：低风险邮件静默收件。'
  return {
    action,
    ruleId: null,
    reason: protectedRule
      ? `安全保护：匹配的静音规则未确认可覆盖重要邮件；${defaultReason}`
      : defaultReason,
    protectedRule
  }
}

function candidateValues({ accountId, senderAddress, category, conversationKey }) {
  const candidates = [
    ['account', normalizeAccountId(accountId)],
    ['category', normalizeEmailNotificationCategory(category)]
  ]
  const sender = String(senderAddress || '').normalize('NFKC').trim().toLowerCase()
  if (EMAIL_PATTERN.test(sender) && sender.length <= 320) {
    candidates.push(['sender', sender])
    try { candidates.push(['domain', normalizeDomain(sender.split('@').pop())]) } catch {}
  }
  const conversation = String(conversationKey || '').trim().toLowerCase()
  if (DIGEST_PATTERN.test(conversation)) candidates.push(['conversation', conversation])
  return candidates
}

export async function resolveEmailNotificationDecision({
  userId,
  accountId,
  senderAddress,
  category,
  conversationKey,
  tier,
  queryFn = query,
  encryptionKey = null,
  recordHit = true
}) {
  if (!UUID_PATTERN.test(String(userId || ''))) throw new TypeError('Email notification owner is invalid')
  const normalizedCategory = normalizeEmailNotificationCategory(category)
  const key = encryptionKey || await loadEmailEncryptionKey()
  const candidates = candidateValues({
    accountId,
    senderAddress,
    category: normalizedCategory,
    conversationKey
  })
  const digests = candidates.map(([scope, value]) => digestEmailNotificationRuleValue(scope, value, key))
  const { rows } = await queryFn(
    `SELECT id, scope, action, priority, critical_override_confirmed,
            explanation, updated_at
     FROM email_notification_rules
     WHERE user_id = $1 AND account_id = $2
       AND enabled = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
       AND match_value_digest = ANY($3::text[])
     ORDER BY priority DESC, updated_at DESC, id ASC`,
    [userId, normalizeAccountId(accountId), digests]
  )
  const critical = Number(tier) === 1 || CRITICAL_CATEGORIES.has(normalizedCategory)
  let protectedRule = false
  for (const row of rows) {
    if (critical && SUPPRESSIVE_ACTIONS.has(row.action) && row.critical_override_confirmed !== true) {
      protectedRule = true
      continue
    }
    if (recordHit) {
      await queryFn(
        `UPDATE email_notification_rules
         SET hit_count = hit_count + 1, last_hit_at = NOW(), updated_at = updated_at
         WHERE id = $1 AND user_id = $2`,
        [row.id, userId]
      )
    }
    return {
      action: row.action,
      ruleId: row.id,
      reason: normalizeText(row.explanation, 600) || '已应用用户邮件通知规则。',
      protectedRule: false
    }
  }
  return defaultDecision(tier, { protectedRule })
}

async function assertOwnedAccount(userId, accountId, queryFn) {
  const normalized = normalizeAccountId(accountId)
  const result = await queryFn(
    'SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2 LIMIT 1',
    [normalized, userId]
  )
  if (!result.rowCount) {
    const error = new Error('Email account not found')
    error.statusCode = 404
    throw error
  }
  return normalized
}

async function decryptRuleMatchValue(row, userId, { encryptionKey = null } = {}) {
  const payload = encryptionKey
    ? decryptEmailPayloadWithKey(row.match_value_encrypted, encryptionKey, {
        context: ruleContext(userId, row.id)
      })
    : await decryptEmailPayload(row.match_value_encrypted, {
        context: ruleContext(userId, row.id)
      })
  return String(payload?.value || '')
}

async function mapRule(row, userId, options = {}) {
  return {
    id: row.id,
    accountId: row.account_id,
    scope: row.scope,
    matchValue: await decryptRuleMatchValue(row, userId, options),
    action: row.action,
    enabled: row.enabled,
    priority: Number(row.priority),
    criticalOverrideConfirmed: row.critical_override_confirmed,
    expiresAt: row.expires_at,
    explanation: row.explanation,
    hitCount: Number(row.hit_count || 0),
    lastHitAt: row.last_hit_at,
    state: !row.enabled ? 'paused' : row.expires_at && new Date(row.expires_at) <= new Date() ? 'expired' : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function listEmailNotificationRules({ userId, accountId = null }, {
  queryFn = query,
  encryptionKey = null
} = {}) {
  if (accountId) await assertOwnedAccount(userId, accountId, queryFn)
  const { rows } = await queryFn(
    `SELECT * FROM email_notification_rules
     WHERE user_id = $1 AND ($2::uuid IS NULL OR account_id = $2)
     ORDER BY account_id, priority DESC, updated_at DESC, id`,
    [userId, accountId || null]
  )
  const key = encryptionKey || await loadEmailEncryptionKey()
  return Promise.all(rows.map((row) => mapRule(row, userId, { encryptionKey: key })))
}

async function recentRuleMatches(normalized, userId, {
  queryFn = query,
  limit = 20
} = {}) {
  const { rows } = await queryFn(
    `SELECT event.id, event.tier, event.category, event.received_at,
            event.event_signature, event.content_encrypted, event.source_key,
            message.thread_key_hash
     FROM email_events AS event
     LEFT JOIN email_messages AS message
       ON message.id = event.email_message_id AND message.user_id = event.user_id
     WHERE event.user_id = $1
       AND message.account_id = $2
     ORDER BY event.received_at DESC, event.id DESC
     LIMIT 200`,
    [userId, normalized.accountId]
  )
  const matches = []
  for (const row of rows) {
    let content
    try {
      content = await decryptEmailPayload(row.content_encrypted, {
        context: `${userId}:${row.source_key}`
      })
    } catch {
      continue
    }
    const sender = String(content.senderAddress || '').trim().toLowerCase()
    let candidate = ''
    if (normalized.scope === 'account') candidate = normalized.accountId
    else if (normalized.scope === 'category') candidate = normalizeEmailNotificationCategory(row.category)
    else if (normalized.scope === 'sender') candidate = sender
    else if (normalized.scope === 'domain') {
      try { candidate = normalizeDomain(sender.split('@').pop()) } catch { candidate = '' }
    } else candidate = String(row.thread_key_hash || row.event_signature || '').toLowerCase()
    if (candidate !== normalized.matchValue) continue
    matches.push({
      id: row.id,
      subject: normalizeText(content.subject || '(无主题)', 500),
      senderName: normalizeText(content.senderName, 320),
      senderAddress: sender,
      category: normalizeEmailNotificationCategory(row.category),
      tier: Number(row.tier),
      receivedAt: row.received_at
    })
    if (matches.length >= Math.max(1, Math.min(Number(limit) || 20, 50))) break
  }
  return matches
}

export async function previewEmailNotificationRule({ userId, payload }, options = {}) {
  const normalized = normalizeEmailNotificationRuleInput(payload)
  await assertOwnedAccount(userId, normalized.accountId, options.queryFn || query)
  const recentMatches = await recentRuleMatches(normalized, userId, options)
  const criticalMatches = recentMatches.filter((match) => (
    match.tier === 1 || CRITICAL_CATEGORIES.has(match.category)
  ))
  const suppressesCritical = SUPPRESSIVE_ACTIONS.has(normalized.action)
  return {
    normalized,
    recentMatches,
    matchCount: recentMatches.length,
    criticalMatchCount: criticalMatches.length,
    requiresCriticalConfirmation: normalized.enabled && suppressesCritical && (
      CRITICAL_CATEGORIES.has(normalized.matchValue)
      || criticalMatches.length > 0
    ),
    explanation: normalized.explanation,
    precedence: ['conversation', 'sender', 'domain', 'category', 'account']
  }
}

function criticalConfirmationError() {
  const error = new Error('Explicit confirmation is required before suppressing critical email notifications')
  error.statusCode = 409
  error.code = 'EMAIL_CRITICAL_NOTIFICATION_CONFIRMATION_REQUIRED'
  return error
}

export async function upsertEmailNotificationRule({ userId, payload }, {
  queryFn = query,
  encryptionKey = null
} = {}) {
  const preview = await previewEmailNotificationRule({ userId, payload }, { queryFn })
  const normalized = preview.normalized
  if (preview.requiresCriticalConfirmation && !normalized.criticalOverrideConfirmed) {
    throw criticalConfirmationError()
  }
  const key = encryptionKey || await loadEmailEncryptionKey()
  const digest = digestEmailNotificationRuleValue(normalized.scope, normalized.matchValue, key)
  const existing = await queryFn(
    `SELECT id FROM email_notification_rules
     WHERE user_id = $1 AND account_id = $2 AND scope = $3
       AND match_value_digest = $4 LIMIT 1`,
    [userId, normalized.accountId, normalized.scope, digest]
  )
  const id = existing.rows[0]?.id || randomUUID()
  const encrypted = encryptEmailPayloadWithKey({ value: normalized.matchValue }, key, {
    context: ruleContext(userId, id)
  })
  const { rows } = await queryFn(
    `INSERT INTO email_notification_rules (
       id, user_id, account_id, scope, action, priority,
       match_value_digest, match_value_encrypted, enabled,
       critical_override_confirmed, expires_at, explanation
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, account_id, scope, match_value_digest) DO UPDATE
     SET action = EXCLUDED.action,
         priority = EXCLUDED.priority,
         match_value_encrypted = CASE
           WHEN email_notification_rules.id = EXCLUDED.id
             THEN EXCLUDED.match_value_encrypted
           ELSE email_notification_rules.match_value_encrypted
         END,
         enabled = EXCLUDED.enabled,
         critical_override_confirmed = EXCLUDED.critical_override_confirmed,
         expires_at = EXCLUDED.expires_at,
         explanation = EXCLUDED.explanation,
         updated_at = NOW()
     RETURNING *`,
    [
      id,
      userId,
      normalized.accountId,
      normalized.scope,
      normalized.action,
      normalized.priority,
      digest,
      encrypted,
      normalized.enabled,
      normalized.criticalOverrideConfirmed,
      normalized.expiresAt,
      normalized.explanation
    ]
  )
  return {
    created: !existing.rowCount && String(rows[0]?.id || '') === id,
    rule: await mapRule(rows[0], userId, { encryptionKey: key }),
    preview: {
      matchCount: preview.matchCount,
      criticalMatchCount: preview.criticalMatchCount,
      requiresCriticalConfirmation: preview.requiresCriticalConfirmation
    }
  }
}

export async function updateEmailNotificationRule({ userId, ruleId, payload }, {
  queryFn = query,
  encryptionKey = null
} = {}) {
  if (!UUID_PATTERN.test(String(ruleId || ''))) throw new TypeError('Email notification rule id is invalid')
  const existing = await queryFn(
    'SELECT * FROM email_notification_rules WHERE id = $1 AND user_id = $2 LIMIT 1',
    [ruleId, userId]
  )
  if (!existing.rowCount) {
    const error = new Error('Email notification rule not found')
    error.statusCode = 404
    throw error
  }
  const key = encryptionKey || await loadEmailEncryptionKey()
  const current = await mapRule(existing.rows[0], userId, { encryptionKey: key })
  if (
    (payload.accountId !== undefined && String(payload.accountId).toLowerCase() !== String(current.accountId).toLowerCase())
    || (payload.scope !== undefined && String(payload.scope).toLowerCase() !== current.scope)
    || (payload.matchValue !== undefined
      && normalizeEmailRuleMatchValue(current.scope, payload.matchValue, current.accountId) !== current.matchValue)
  ) {
    throw new TypeError('Email notification rule identity cannot be changed; delete and recreate the rule')
  }
  const merged = {
    accountId: current.accountId,
    scope: current.scope,
    matchValue: current.matchValue,
    action: payload.action ?? current.action,
    enabled: payload.enabled ?? current.enabled,
    expiresAt: Object.hasOwn(payload, 'expiresAt')
      ? payload.expiresAt
      : current.expiresAt && new Date(current.expiresAt) > new Date()
        ? current.expiresAt
        : null,
    criticalOverrideConfirmed: Object.hasOwn(payload, 'criticalOverrideConfirmed')
      ? payload.criticalOverrideConfirmed
      : current.criticalOverrideConfirmed
  }
  const upserted = await upsertEmailNotificationRule({ userId, payload: merged }, {
    queryFn,
    encryptionKey: key
  })
  if (String(upserted.rule.id) !== String(ruleId)) {
    const error = new Error('Email notification rule identity conflicts with an existing rule')
    error.statusCode = 409
    throw error
  }
  return upserted.rule
}

export async function deleteEmailNotificationRule({ userId, ruleId }, { queryFn = query } = {}) {
  if (!UUID_PATTERN.test(String(ruleId || ''))) throw new TypeError('Email notification rule id is invalid')
  const result = await queryFn(
    'DELETE FROM email_notification_rules WHERE id = $1 AND user_id = $2 RETURNING id',
    [ruleId, userId]
  )
  if (!result.rowCount) {
    const error = new Error('Email notification rule not found')
    error.statusCode = 404
    throw error
  }
  return { id: result.rows[0].id, deleted: true }
}

export function publicEmailNotificationDecision(row = {}) {
  const tier = Number(row.tier || 3)
  return {
    category: normalizeEmailNotificationCategory(row.category),
    importanceScore: Number.isSafeInteger(Number(row.importance_score))
      ? Number(row.importance_score)
      : emailImportanceScore(tier, row.urgency),
    notificationAction: ACTION_SET.has(String(row.notification_action || ''))
      ? row.notification_action
      : defaultEmailNotificationAction(tier),
    notificationReason: normalizeText(row.notification_reason, 1000)
      || defaultDecision(tier).reason,
    notificationRuleId: row.notification_rule_id || null
  }
}
