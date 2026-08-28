import { createHash } from 'node:crypto'

export const EMAIL_REMOTE_COMMAND_ACTIONS = Object.freeze([
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'archive',
  'move',
  'trash',
  'delete'
])

export const EMAIL_REMOTE_COMMAND_UNDO_SECONDS = 10
export const EMAIL_REMOTE_DELETE_CONFIRMATION = 'DELETE_PERMANENTLY'

const ACTIONS = new Set(EMAIL_REMOTE_COMMAND_ACTIONS)
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/
const UINT32_MAX = 4_294_967_295n
const UINT64_MAX = 18_446_744_073_709_551_615n
const FLAG_ACTIONS = new Set(['mark_read', 'mark_unread', 'star', 'unstar'])
const NON_RETRYABLE_ERROR_CODES = new Set([
  'REMOTE_COMMAND_CONFLICT',
  'REMOTE_COMMAND_RESULT_UNKNOWN',
  'REMOTE_UIDVALIDITY_CHANGED',
  'REMOTE_MESSAGE_MISSING',
  'REMOTE_STATE_CHANGED',
  'REMOTE_TARGET_MISSING',
  'REMOTE_TARGET_AMBIGUOUS',
  'REMOTE_TARGET_SAME_FOLDER',
  'REMOTE_SOURCE_ACCOUNT_MISMATCH',
  'REMOTE_DELETE_NOT_ALLOWED'
])

export class EmailRemoteCommandError extends Error {
  constructor(message, { code = 'REMOTE_COMMAND_INVALID', statusCode = 400 } = {}) {
    super(message)
    this.name = 'EmailRemoteCommandError'
    this.code = code
    this.statusCode = statusCode
  }
}

function requiredUnsignedInteger(value, { label, maximum, allowNull = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowNull) return null
    throw new EmailRemoteCommandError(`${label} is required`)
  }
  const raw = String(value).trim()
  if (!/^\d+$/.test(raw)) throw new EmailRemoteCommandError(`${label} is invalid`)
  const parsed = BigInt(raw)
  if (parsed < 1n || parsed > maximum) throw new EmailRemoteCommandError(`${label} is invalid`)
  return parsed.toString()
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new EmailRemoteCommandError(`${label} is required`)
  return value
}

function normalizeUuid(value, { required = false, label = 'Folder id' } = {}) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized && !required) return null
  if (!UUID_PATTERN.test(normalized)) throw new EmailRemoteCommandError(`${label} is invalid`)
  return normalized
}

function normalizeFlags(value = {}) {
  return {
    seen: Boolean(value.seen),
    flagged: Boolean(value.flagged),
    deleted: Boolean(value.deleted)
  }
}

export function normalizeEmailRemoteCommandRequest(input = {}) {
  const action = String(input.action || '').trim().toLowerCase()
  if (!ACTIONS.has(action)) throw new EmailRemoteCommandError('Unsupported email command action')
  const idempotencyKey = String(input.idempotencyKey || '').normalize('NFKC').trim()
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new EmailRemoteCommandError('A valid idempotency key is required')
  }
  const expected = input.expected && typeof input.expected === 'object'
    ? input.expected
    : {}
  const targetFolderId = normalizeUuid(input.targetFolderId, {
    required: action === 'move',
    label: 'Target folder id'
  })
  if (action !== 'move' && targetFolderId) {
    throw new EmailRemoteCommandError('Target folder is only valid for move')
  }
  if (action === 'delete' && String(input.confirm || '') !== EMAIL_REMOTE_DELETE_CONFIRMATION) {
    throw new EmailRemoteCommandError(
      'Permanent deletion requires explicit confirmation',
      { code: 'REMOTE_DELETE_CONFIRMATION_REQUIRED', statusCode: 422 }
    )
  }
  return Object.freeze({
    action,
    targetFolderId,
    idempotencyKey,
    permanentConfirmed: action === 'delete',
    expected: Object.freeze({
      uidValidity: requiredUnsignedInteger(expected.uidValidity, {
        label: 'Expected UIDVALIDITY', maximum: UINT32_MAX
      }),
      modseq: requiredUnsignedInteger(expected.modseq, {
        label: 'Expected MODSEQ', maximum: UINT64_MAX, allowNull: true
      }),
      seen: requiredBoolean(expected.seen, 'Expected seen state'),
      flagged: requiredBoolean(expected.flagged, 'Expected flagged state'),
      deleted: requiredBoolean(expected.deleted, 'Expected deleted state')
    })
  })
}

export function buildEmailRemoteCommandRequestHash({ accountId, locationId, command }) {
  const canonical = JSON.stringify({
    accountId: String(accountId || '').toLowerCase(),
    locationId: String(locationId || '').toLowerCase(),
    action: command.action,
    targetFolderId: command.targetFolderId,
    expected: command.expected,
    permanentConfirmed: command.permanentConfirmed
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function desiredRemoteFlagState(action, current = {}) {
  const flags = normalizeFlags(current)
  if (action === 'mark_read') return { ...flags, seen: true }
  if (action === 'mark_unread') return { ...flags, seen: false }
  if (action === 'star') return { ...flags, flagged: true }
  if (action === 'unstar') return { ...flags, flagged: false }
  return null
}

export function isEmailRemoteCommandSatisfied(action, current = {}) {
  const flags = normalizeFlags(current)
  if (action === 'mark_read') return flags.seen
  if (action === 'mark_unread') return !flags.seen
  if (action === 'star') return flags.flagged
  if (action === 'unstar') return !flags.flagged
  return false
}

export function compareEmailRemoteSnapshot(expected, current, { action } = {}) {
  if (String(expected.uidValidity) !== String(current.uidValidity || '')) {
    return { ok: false, code: 'REMOTE_UIDVALIDITY_CHANGED' }
  }
  if (FLAG_ACTIONS.has(action) && isEmailRemoteCommandSatisfied(action, current)) {
    return { ok: true, alreadySatisfied: true }
  }
  if (expected.modseq != null && String(expected.modseq) !== String(current.modseq || '')) {
    return { ok: false, code: 'REMOTE_STATE_CHANGED' }
  }
  for (const key of ['seen', 'flagged', 'deleted']) {
    if (Boolean(expected[key]) !== Boolean(current[key])) {
      return { ok: false, code: 'REMOTE_STATE_CHANGED' }
    }
  }
  return { ok: true, alreadySatisfied: false }
}

export function assertPermanentDeleteAllowed({ specialUse, deleted } = {}) {
  const normalizedSpecialUse = String(specialUse || '').trim().toLowerCase().replace(/^\\/, '')
  if (!['trash', 'junk'].includes(normalizedSpecialUse) && !Boolean(deleted)) {
    throw new EmailRemoteCommandError(
      'Permanent deletion is limited to Trash/Junk or messages already marked deleted',
      { code: 'REMOTE_DELETE_NOT_ALLOWED', statusCode: 409 }
    )
  }
}

export function retryDelaySeconds(attemptCount) {
  const attempt = Math.max(1, Math.min(10, Number(attemptCount) || 1))
  return Math.min(300, 2 ** attempt)
}

export function classifyRemoteCommandFailure({ action, errorCode, mutationStarted }) {
  const code = String(errorCode || 'REMOTE_COMMAND_FAILED').toUpperCase()
  if (code === 'REMOTE_COMMAND_RESULT_UNKNOWN' && FLAG_ACTIONS.has(action)) return 'retry'
  if (NON_RETRYABLE_ERROR_CODES.has(code)) return 'conflict'
  if (mutationStarted && !FLAG_ACTIONS.has(action)) return 'conflict'
  return 'retry'
}

export function isFlagOnlyRemoteCommand(action) {
  return FLAG_ACTIONS.has(String(action || ''))
}
