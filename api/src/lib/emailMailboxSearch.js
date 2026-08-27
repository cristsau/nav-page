export const EMAIL_MAILBOX_FILTERS = Object.freeze([
  'all',
  'unread',
  'flagged',
  'attachments'
])

export const EMAIL_MAILBOX_SEARCH_LIMITS = Object.freeze({
  queryCharacters: 120,
  scanRows: 1_200,
  scanBatchRows: 160
})

function normalizedText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
}

function addressText(value) {
  if (!value || typeof value !== 'object') return ''
  return `${value.name || ''} ${value.address || ''}`
}

export function normalizeMailboxSearchQuery(value) {
  const query = String(value || '').trim()
  if (query.length > EMAIL_MAILBOX_SEARCH_LIMITS.queryCharacters) {
    throw new TypeError(`Email search query must be ${EMAIL_MAILBOX_SEARCH_LIMITS.queryCharacters} characters or fewer`)
  }
  return query.normalize('NFKC')
}

export function normalizeMailboxFilter(value) {
  const filter = String(value || 'all').trim().toLocaleLowerCase('en-US') || 'all'
  if (!EMAIL_MAILBOX_FILTERS.includes(filter)) {
    throw new TypeError('Invalid email message filter')
  }
  return filter
}

export function mailboxFilterSql(filter, { locationAlias = 'location', messageAlias = 'message' } = {}) {
  if (filter === 'unread') return `AND ${locationAlias}.seen = FALSE`
  if (filter === 'flagged') return `AND ${locationAlias}.flagged = TRUE`
  if (filter === 'attachments') return `AND ${messageAlias}.has_attachments = TRUE`
  return ''
}

export function mailboxMessageMatchesQuery(message, query) {
  const needle = normalizedText(query)
  if (!needle) return true
  const haystack = normalizedText([
    message?.subject,
    message?.preview,
    message?.body,
    addressText(message?.from),
    ...(Array.isArray(message?.to) ? message.to.map(addressText) : []),
    ...(Array.isArray(message?.cc) ? message.cc.map(addressText) : [])
  ].join('\n'))
  return haystack.includes(needle)
}
