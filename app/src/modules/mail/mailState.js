function itemId(item) {
  return String(item?.id || item?.messageId || '').trim()
}

function messageTimestamp(item) {
  const value = item?.internalDate || item?.receivedAt || item?.latestAt || item?.sentAt || item?.createdAt
  const timestamp = Date.parse(value || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function revisionRank(value) {
  const numeric = Number(value || 0)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function pageKey(accountId, folderId) {
  return `${String(accountId || '')}:${String(folderId || '')}`
}

export function createRequestGenerationGate() {
  let resetGeneration = 0
  const generations = new Map()

  function begin(scope) {
    const key = String(scope || '')
    const generation = Number(generations.get(key) || 0) + 1
    generations.set(key, generation)
    return { scope: key, generation, resetGeneration }
  }

  function isCurrent(ticket) {
    if (!ticket || ticket.resetGeneration !== resetGeneration) return false
    return Number(generations.get(ticket.scope) || 0) === ticket.generation
  }

  function invalidate(scope) {
    return begin(scope)
  }

  function reset() {
    resetGeneration += 1
    generations.clear()
  }

  return { begin, isCurrent, invalidate, reset }
}

export function emptyMessagePage() {
  return {
    items: [],
    nextCursor: '',
    hasMore: false,
    revision: 0,
    loaded: false,
    invalidated: false
  }
}

export function mergeMessageItems(current = [], incoming = [], { replace = false } = {}) {
  const merged = new Map()
  const source = replace ? incoming : [...current, ...incoming]
  for (const item of source) {
    const id = itemId(item)
    if (!id) continue
    const previous = merged.get(id)
    merged.set(id, previous ? { ...previous, ...item, id } : { ...item, id })
  }
  return [...merged.values()].sort((left, right) => (
    messageTimestamp(right) - messageTimestamp(left)
    || itemId(right).localeCompare(itemId(left))
  ))
}

export function mergeMessagePage(current, payload = {}, { replace = false } = {}) {
  const base = current || emptyMessagePage()
  const incoming = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.items) ? payload.items : []
  return {
    items: mergeMessageItems(base.items, incoming, { replace }),
    nextCursor: String(payload.nextCursor || ''),
    hasMore: Boolean(payload.hasMore ?? payload.nextCursor),
    revision: revisionRank(payload.revision) >= revisionRank(base.revision)
      ? (payload.revision || base.revision || 0)
      : base.revision,
    loaded: true,
    invalidated: false
  }
}

export function markPageInvalidated(current, event = {}) {
  const base = current || emptyMessagePage()
  const revision = event.revision || event.payload?.revision || 0
  // PostgreSQL timestamps can share the same millisecond. Equal revisions may
  // still describe different locations, so reject only strictly older events.
  if (revisionRank(revision) && revisionRank(revision) < revisionRank(base.revision)) {
    return { page: base, changed: false }
  }
  return {
    page: {
      ...base,
      revision: revisionRank(revision) >= revisionRank(base.revision) ? revision : base.revision,
      invalidated: true
    },
    changed: true
  }
}

export function defaultFolderId(folders = []) {
  const inbox = folders.find((folder) => {
    const specialUse = String(folder?.specialUse || folder?.role || '').toLowerCase()
    return specialUse === 'inbox' || specialUse === '\\inbox'
  })
  return String(inbox?.id || folders[0]?.id || '')
}

export function isMailInvalidationEvent(eventName) {
  return [
    'message',
    'message.created',
    'message.updated',
    'message.removed',
    'folder.updated',
    'folder.counts',
    'mail.message.upserted',
    'mail.message.removed',
    'mail.folder.counts',
    'mail.changed',
    'sync.state',
    'reset'
  ].includes(String(eventName || '').toLowerCase())
}
