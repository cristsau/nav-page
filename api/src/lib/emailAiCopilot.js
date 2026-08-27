import { createHash } from 'node:crypto'
import { redactEmailBodyForAi, redactEmailForAi } from './emailPrivacy.js'

export const EMAIL_AI_COPILOT_LIMITS = Object.freeze({
  threadMessages: 20,
  searchCandidates: 200,
  searchResults: 8,
  searchQuery: 240,
  sourceBody: 4_000,
  cacheEntries: 200,
  cacheTtlMs: 5 * 60 * 1000
})

function normalizedText(value, maximum) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function addressText(value) {
  if (!value || typeof value !== 'object') return normalizedText(value, 320)
  return normalizedText(value.address || value.name, 320)
}

function tokenize(value) {
  const source = normalizedText(value, EMAIL_AI_COPILOT_LIMITS.searchQuery).toLowerCase()
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}_.@+-]*/gu) || []
  const compactCjk = source.replace(/[^\p{Script=Han}]/gu, '')
  const cjk = []
  for (let index = 0; index < compactCjk.length; index += 1) {
    cjk.push(compactCjk.slice(index, index + 2))
  }
  return [...new Set([...words, ...cjk].filter((item) => item.length >= 2))].slice(0, 24)
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

export class EmailAiResponseCache {
  constructor({
    maximum = EMAIL_AI_COPILOT_LIMITS.cacheEntries,
    ttlMs = EMAIL_AI_COPILOT_LIMITS.cacheTtlMs,
    now = Date.now
  } = {}) {
    this.maximum = Math.max(1, Number(maximum) || EMAIL_AI_COPILOT_LIMITS.cacheEntries)
    this.ttlMs = Math.max(1_000, Number(ttlMs) || EMAIL_AI_COPILOT_LIMITS.cacheTtlMs)
    this.now = now
    this.entries = new Map()
  }

  get(key) {
    const entry = this.entries.get(String(key || ''))
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(String(key || ''))
      return null
    }
    this.entries.delete(String(key || ''))
    this.entries.set(String(key || ''), entry)
    return clone(entry.value)
  }

  set(key, value) {
    const normalized = String(key || '')
    if (!normalized) return
    this.entries.delete(normalized)
    this.entries.set(normalized, {
      expiresAt: this.now() + this.ttlMs,
      value: clone(value)
    })
    while (this.entries.size > this.maximum) {
      this.entries.delete(this.entries.keys().next().value)
    }
  }

  clear() {
    this.entries.clear()
  }
}

export function deriveEmailResourceVersion(row) {
  const rawDate = new Date(row?.updated_at || row?.received_at || 0)
  const timestamp = Number.isNaN(rawDate.getTime()) ? 'invalid' : rawDate.toISOString()
  const source = [
    String(row?.message_id || row?.id || ''),
    String(row?.canonical_hash || ''),
    timestamp
  ].join(':')
  return createHash('sha256').update(source).digest('hex')
}

export function deriveEmailThreadResourceVersion(messages, fallback = '') {
  const versions = (Array.isArray(messages) ? messages : [])
    .map((message) => String(message?.resourceVersion || ''))
    .filter((value) => /^[0-9a-f]{64}$/i.test(value))
  return createHash('sha256')
    .update(JSON.stringify(versions.length ? versions : [String(fallback || '')]))
    .digest('hex')
}

export function buildEmailAiCacheKey({
  userId,
  action,
  resourceVersion,
  instruction = '',
  language = '',
  replyTone = '',
  replyLength = '',
  model = '',
  calendarDate = ''
}) {
  return createHash('sha256').update(JSON.stringify({
    userId, action, resourceVersion,
    instruction: normalizedText(instruction, 1_000),
    language: normalizedText(language, 80),
    replyTone: normalizedText(replyTone, 24),
    replyLength: normalizedText(replyLength, 24),
    model: normalizedText(model, 120),
    calendarDate: normalizedText(calendarDate, 10)
  })).digest('hex')
}

function toAiMessage(row, decrypted) {
  return {
    messageId: row.message_id,
    subject: decrypted.envelope?.subject,
    sender: addressText(decrypted.envelope?.sender),
    to: decrypted.envelope?.to,
    cc: decrypted.envelope?.cc,
    receivedAt: row.received_at,
    text: decrypted.content?.text,
    resourceVersion: deriveEmailResourceVersion(row)
  }
}

export async function loadOwnedEmailThread({
  userId,
  messageRow,
  queryFn,
  decryptMessage,
  maximum = EMAIL_AI_COPILOT_LIMITS.threadMessages
}) {
  if (!messageRow?.thread_key_hash) {
    return [toAiMessage(messageRow, await decryptMessage(messageRow))]
  }
  const limit = Math.min(Math.max(1, Number(maximum) || 1), EMAIL_AI_COPILOT_LIMITS.threadMessages)
  const { rows } = await queryFn(
    `SELECT message.id AS message_id, message.account_id, message.user_id,
            account.source_key, message.canonical_hash, message.thread_key_hash,
            message.envelope_encrypted, message.content_encrypted,
            message.received_at, message.updated_at
     FROM email_messages AS message
     JOIN email_accounts AS account
       ON account.id = message.account_id AND account.user_id = message.user_id
     WHERE message.user_id = $1 AND message.account_id = $2
       AND message.thread_key_hash = $3
     ORDER BY message.received_at DESC, message.id DESC
     LIMIT $4`,
    [userId, messageRow.account_id, messageRow.thread_key_hash, limit]
  )
  const messages = []
  for (const row of [...rows].reverse()) {
    try { messages.push(toAiMessage(row, await decryptMessage(row))) } catch {}
  }
  if (!messages.some((item) => String(item.messageId) === String(messageRow.message_id))) {
    try { messages.push(toAiMessage(messageRow, await decryptMessage(messageRow))) } catch {}
  }
  return messages.slice(-limit)
}

function relevanceScore(tokens, { subject, sender, body }) {
  let score = 0
  for (const token of tokens) {
    if (subject.includes(token)) score += 5
    if (sender.includes(token)) score += 3
    if (body.includes(token)) score += 1
  }
  return score
}

export async function searchOwnedEmails({
  userId,
  search,
  queryFn,
  decryptMessage,
  candidateLimit = EMAIL_AI_COPILOT_LIMITS.searchCandidates,
  resultLimit = EMAIL_AI_COPILOT_LIMITS.searchResults
}) {
  const queryText = normalizedText(search, EMAIL_AI_COPILOT_LIMITS.searchQuery)
  const tokens = tokenize(queryText)
  if (!tokens.length) throw new TypeError('邮件搜索词过短')
  const candidates = Math.min(
    Math.max(1, Number(candidateLimit) || 1),
    EMAIL_AI_COPILOT_LIMITS.searchCandidates
  )
  const results = Math.min(
    Math.max(1, Number(resultLimit) || 1),
    EMAIL_AI_COPILOT_LIMITS.searchResults
  )
  const { rows } = await queryFn(
    `SELECT message.id AS message_id, message.account_id, message.user_id,
            account.source_key, message.canonical_hash, message.thread_key_hash,
            message.envelope_encrypted, message.content_encrypted,
            message.received_at, message.updated_at,
            location.location_id, location.folder_id
     FROM email_messages AS message
     JOIN email_accounts AS account
       ON account.id = message.account_id AND account.user_id = message.user_id
     LEFT JOIN LATERAL (
       SELECT candidate.id AS location_id, candidate.folder_id
       FROM email_folder_messages AS candidate
       JOIN email_folders AS folder
         ON folder.id = candidate.folder_id
        AND folder.account_id = candidate.account_id
        AND folder.user_id = candidate.user_id
       WHERE candidate.message_id = message.id
         AND candidate.account_id = message.account_id
         AND candidate.user_id = message.user_id
         AND candidate.expunged_at IS NULL
       ORDER BY
         CASE folder.special_use
           WHEN 'inbox' THEN 0 WHEN 'flagged' THEN 1 WHEN 'sent' THEN 2
           WHEN 'drafts' THEN 3 WHEN 'archive' THEN 4 WHEN 'trash' THEN 8
           WHEN 'junk' THEN 9 ELSE 6
         END,
         candidate.internal_date DESC,
         candidate.id DESC
       LIMIT 1
     ) AS location ON TRUE
     WHERE message.user_id = $1
     ORDER BY message.received_at DESC, message.id DESC
     LIMIT $2`,
    [userId, candidates]
  )
  const scored = []
  for (const row of rows) {
    try {
      const decrypted = await decryptMessage(row)
      const subject = normalizedText(decrypted.envelope?.subject, 500).toLowerCase()
      const sender = addressText(decrypted.envelope?.sender).toLowerCase()
      const body = normalizedText(decrypted.content?.text, 40_000).toLowerCase()
      const score = relevanceScore(tokens, { subject, sender, body })
      if (!score) continue
      scored.push({ row, decrypted, score })
    } catch {}
  }
  return scored
    .sort((left, right) => right.score - left.score
      || new Date(right.row.received_at) - new Date(left.row.received_at))
    .slice(0, results)
    .map(({ row, decrypted, score }, index) => ({
      sourceId: `M${index + 1}`,
      messageId: row.message_id,
      accountId: row.account_id,
      folderId: row.folder_id || null,
      locationId: row.location_id || null,
      subject: redactEmailForAi(normalizedText(decrypted.envelope?.subject, 500), 500),
      sender: redactEmailForAi(addressText(decrypted.envelope?.sender), 320),
      receivedAt: row.received_at,
      text: redactEmailBodyForAi(
        String(decrypted.content?.text || '').slice(0, EMAIL_AI_COPILOT_LIMITS.sourceBody),
        EMAIL_AI_COPILOT_LIMITS.sourceBody
      ),
      score
    }))
}
