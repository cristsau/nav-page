import { createHash } from 'node:crypto'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const OFFLINE_MUTATION_KINDS = Object.freeze([
  'note.create',
  'note.update',
  'note.metadata',
  'note.delete',
  'comment.create',
  'comment.update',
  'comment.resolve',
  'comment.delete'
])

export function isUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim())
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

export function offlineMutationHash(kind, payload) {
  return createHash('sha256')
    .update(stableJson({ kind, payload: payload || {} }))
    .digest('hex')
}

export function normalizeOfflineMutation(raw) {
  const operationId = String(raw?.operationId || '').trim()
  const kind = String(raw?.kind || '').trim()
  const payload = raw?.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    ? raw.payload
    : null
  if (!isUuid(operationId) || !OFFLINE_MUTATION_KINDS.includes(kind) || !payload) {
    return null
  }
  return { operationId, kind, payload }
}
