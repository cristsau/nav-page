const PUBLIC_ERROR_CODE_PATTERN = /^[A-Z0-9_.-]{1,64}$/

function timestamp(value) {
  const parsed = new Date(value || 0).getTime()
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function createMailSyncPollEpochGate() {
  let epoch = 0

  return {
    begin() {
      epoch += 1
      return epoch
    },
    invalidate() {
      epoch += 1
      return epoch
    },
    isCurrent(ticket) {
      return Number.isSafeInteger(ticket) && ticket === epoch
    }
  }
}

export function mailSyncFailureForRequest(payload = {}, requestedAt = '') {
  const code = String(payload?.lastErrorCode || '').trim().toUpperCase()
  const failureAt = timestamp(payload?.lastErrorAt)
  const requestAt = timestamp(payload?.requestedAt || requestedAt)

  if (!PUBLIC_ERROR_CODE_PATTERN.test(code) || !failureAt || !requestAt || failureAt < requestAt) {
    return null
  }

  return {
    code,
    at: new Date(failureAt).toISOString()
  }
}
