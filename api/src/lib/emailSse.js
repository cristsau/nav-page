const DEFAULT_MAX_CONNECTIONS = 3

function connectionKey(userId, accountId) {
  return JSON.stringify([String(userId || ''), String(accountId || '')])
}

export function createEmailSseConnectionLimiter({ maxConnections = DEFAULT_MAX_CONNECTIONS } = {}) {
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new TypeError('Email SSE maxConnections must be a positive safe integer')
  }

  const activeConnections = new Map()

  return Object.freeze({
    acquire({ userId, accountId }) {
      const key = connectionKey(userId, accountId)
      const active = activeConnections.get(key) || 0
      if (active >= maxConnections) return null

      activeConnections.set(key, active + 1)
      let released = false
      return () => {
        if (released) return false
        released = true
        const current = activeConnections.get(key) || 0
        if (current <= 1) activeConnections.delete(key)
        else activeConnections.set(key, current - 1)
        return true
      }
    },
    count({ userId, accountId }) {
      return activeConnections.get(connectionKey(userId, accountId)) || 0
    }
  })
}

function terminateStream(stream) {
  try {
    if (typeof stream.destroy === 'function') stream.destroy()
    else if (!stream.writableEnded && typeof stream.end === 'function') stream.end()
  } catch {}
}

export function writeEmailSse(stream, event, data, id = '') {
  if (!stream || stream.destroyed || stream.writableEnded) return false
  const safeEvent = String(event || 'message').replace(/[\r\n]/g, '') || 'message'
  const safeId = String(id || '').replace(/[\r\n]/g, '')
  const frame = `${safeId ? `id: ${safeId}\n` : ''}event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`

  try {
    const accepted = stream.write(frame)
    if (!accepted) terminateStream(stream)
    return accepted
  } catch {
    terminateStream(stream)
    return false
  }
}
