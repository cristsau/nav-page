const MAX_DELETE_IDS = 100
const BIGINT_MAX = 9_223_372_036_854_775_807n

export function validateSecurityEventDeletion(value = {}) {
  const currentPassword = String(value?.currentPassword || '')
  if (!currentPassword) {
    return { valid: false, error: 'Current password is required' }
  }
  if (!Array.isArray(value?.eventIds) || value.eventIds.length === 0) {
    return { valid: false, error: 'At least one security event must be selected' }
  }
  if (value.eventIds.length > MAX_DELETE_IDS) {
    return {
      valid: false,
      error: `No more than ${MAX_DELETE_IDS} security events can be deleted at once`
    }
  }

  const eventIds = []
  const seen = new Set()
  for (const valueId of value.eventIds) {
    const normalized = typeof valueId === 'number'
      && Number.isSafeInteger(valueId)
      && valueId > 0
      ? String(valueId)
      : String(valueId || '').trim()
    if (!/^[1-9]\d{0,18}$/.test(normalized)) {
      return { valid: false, error: 'Invalid security event ID' }
    }
    if (BigInt(normalized) > BIGINT_MAX) {
      return { valid: false, error: 'Invalid security event ID' }
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      eventIds.push(normalized)
    }
  }

  return {
    valid: true,
    currentPassword,
    eventIds
  }
}
