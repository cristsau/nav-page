function normalizedText(value) {
  return String(value || '').trim()
}

function safeInternalUrl(value) {
  const url = normalizedText(value)
  return url.startsWith('/') && !url.startsWith('//') ? url : ''
}

function firstDigestEmailId(item) {
  const ids = item?.metadata?.emailEventIds
  return Array.isArray(ids) ? normalizedText(ids[0]) : ''
}

function firstDigestEmailDetail(item) {
  const emails = item?.detail?.emails
  return Array.isArray(emails)
    ? emails.find((email) => email && typeof email === 'object') || null
    : null
}

function mailMessageDestination(item) {
  const detail = item?.detail && typeof item.detail === 'object' ? item.detail : {}
  const accountId = normalizedText(detail.accountId)
  const folderId = normalizedText(detail.folderId)
  const locationId = normalizedText(detail.locationId)

  if (accountId && folderId && locationId) {
    return {
      path: '/mail',
      query: { account: accountId, folder: folderId, message: locationId }
    }
  }

  const emailEventId = normalizedText(item?.sourceId || detail.id)
  return emailEventId
    ? { path: '/mail', query: { email: emailEventId } }
    : { path: '/mail' }
}

function historicalAssistantMailDestination(actionUrl) {
  if (!actionUrl.startsWith('/assistant')) return null
  let parsed
  try {
    parsed = new URL(actionUrl, 'https://nav.invalid')
  } catch {
    return null
  }
  if (parsed.pathname !== '/assistant') return null
  const emailEventId = normalizedText(parsed.searchParams.get('email'))
  if (emailEventId) return { path: '/mail', query: { email: emailEventId } }
  return parsed.searchParams.get('view') === 'email' ? { path: '/mail' } : null
}

/**
 * Return a Vue Router destination for a notification.
 *
 * Email source metadata is authoritative so notifications created before the
 * mailbox workspace existed cannot strand the user on the assistant route.
 */
export function resolveNotificationDestination(item = {}) {
  const sourceType = normalizedText(item.sourceType).toLowerCase()
  if (sourceType === 'email') return mailMessageDestination(item)
  if (sourceType === 'email_digest') {
    const email = firstDigestEmailDetail(item)
    if (email) {
      return mailMessageDestination({
        sourceId: email.id,
        detail: email
      })
    }
    const emailEventId = firstDigestEmailId(item)
    return emailEventId
      ? { path: '/mail', query: { email: emailEventId } }
      : { path: '/mail' }
  }

  const actionUrl = safeInternalUrl(item.actionUrl)
  return historicalAssistantMailDestination(actionUrl) || actionUrl || null
}
