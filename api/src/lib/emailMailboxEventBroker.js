const DEFAULT_CHANNEL = 'nav_email_mailbox_changes'
const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const METADATA_FIELDS = [
  'userId',
  'accountId',
  'folderId',
  'messageId',
  'locationId'
]

function quoteIdentifier(value) {
  const channel = String(value || '').trim()
  if (!CHANNEL_PATTERN.test(channel)) throw new TypeError('Email mailbox event channel is invalid')
  return `"${channel}"`
}

function normalizeMetadataValue(value) {
  if (value === null || value === undefined) return undefined
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, 160) : undefined
}

export function parseEmailMailboxEventPayload(rawPayload) {
  let source
  try {
    source = typeof rawPayload === 'string'
      ? JSON.parse(rawPayload || '{}')
      : rawPayload
  } catch {
    return null
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null

  const event = {}
  for (const field of METADATA_FIELDS) {
    const value = normalizeMetadataValue(source[field])
    if (value !== undefined) event[field] = value
  }
  const revision = Number(source.revision)
  if (Number.isSafeInteger(revision) && revision >= 0) event.revision = revision

  // A mailbox event without ownership and account metadata cannot be routed
  // safely. Reconstructing the object also guarantees that envelope/body data
  // from a malformed producer is never fanned out to browser subscribers.
  if (!event.userId || !event.accountId) return null
  return Object.freeze(event)
}

function removeListener(client, event, handler) {
  if (typeof client.off === 'function') client.off(event, handler)
  else client.removeListener?.(event, handler)
}

/**
 * Owns one PostgreSQL LISTEN session per Node.js process and fans sanitized
 * mailbox metadata out to any number of local SSE consumers.
 */
export function createEmailMailboxEventBroker({
  poolInstance,
  channel = DEFAULT_CHANNEL,
  logger = null
} = {}) {
  if (!poolInstance || typeof poolInstance.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with connect() is required')
  }
  const quotedChannel = quoteIdentifier(channel)
  const subscribers = new Set()
  const releasedClients = new WeakSet()
  let listener = null
  let listenerHandlers = null
  let startPromise = null
  let closePromise = null
  let desiredRunning = false

  function releaseOnce(client, error) {
    if (!client || releasedClients.has(client)) return
    releasedClients.add(client)
    client.release(error || undefined)
  }

  function notifyError(error) {
    for (const subscriber of [...subscribers]) {
      if (typeof subscriber.onError !== 'function') continue
      try { subscriber.onError(error) } catch (callbackError) {
        logger?.warn?.({ err: callbackError }, 'email mailbox broker error subscriber failed')
      }
    }
  }

  function fanOut(event) {
    for (const subscriber of [...subscribers]) {
      if (typeof subscriber.onEvent !== 'function') continue
      try { subscriber.onEvent(event) } catch (error) {
        logger?.warn?.({ err: error }, 'email mailbox broker event subscriber failed')
      }
    }
  }

  function detach(client, handlers) {
    if (!client || !handlers) return
    removeListener(client, 'notification', handlers.onNotification)
    removeListener(client, 'error', handlers.onError)
    removeListener(client, 'end', handlers.onEnd)
  }

  async function handleListenerError(client, handlers, rawError) {
    if (listener !== client) return
    const error = rawError instanceof Error
      ? rawError
      : new Error('Email mailbox event listener failed')
    listener = null
    listenerHandlers = null
    desiredRunning = false
    detach(client, handlers)
    releaseOnce(client, error)
    notifyError(error)
  }

  async function start() {
    desiredRunning = true
    if (listener) return listener
    if (startPromise) return startPromise
    if (closePromise) await closePromise
    if (listener) return listener

    const pending = (async () => {
      const client = await poolInstance.connect()
      try {
        await client.query(`LISTEN ${quotedChannel}`)
      } catch (error) {
        releaseOnce(client, error)
        throw error
      }

      if (!desiredRunning) {
        try { await client.query(`UNLISTEN ${quotedChannel}`) } catch {}
        releaseOnce(client)
        return null
      }

      const handlers = {
        onNotification(notification) {
          if (notification?.channel !== channel) return
          const event = parseEmailMailboxEventPayload(notification.payload)
          if (event) fanOut(event)
        },
        onError(error) {
          void handleListenerError(client, handlers, error)
        },
        onEnd() {
          void handleListenerError(client, handlers, new Error('Email mailbox event listener ended'))
        }
      }
      listener = client
      listenerHandlers = handlers
      client.on('notification', handlers.onNotification)
      client.on('error', handlers.onError)
      client.on('end', handlers.onEnd)
      return client
    })()
    startPromise = pending
    try {
      return await pending
    } finally {
      if (startPromise === pending) startPromise = null
    }
  }

  function subscribe({ onEvent = null, onError = null } = {}) {
    if (typeof onEvent !== 'function' && typeof onError !== 'function') {
      throw new TypeError('A mailbox event or error subscriber is required')
    }
    const subscriber = { onEvent, onError }
    subscribers.add(subscriber)
    let active = true
    return () => {
      if (!active) return false
      active = false
      return subscribers.delete(subscriber)
    }
  }

  async function close() {
    desiredRunning = false
    if (closePromise) return closePromise
    const pending = (async () => {
      if (startPromise) {
        try { await startPromise } catch {}
      }
      const client = listener
      const handlers = listenerHandlers
      listener = null
      listenerHandlers = null
      if (!client) return
      detach(client, handlers)
      try { await client.query(`UNLISTEN ${quotedChannel}`) } catch {}
      releaseOnce(client)
    })()
    closePromise = pending
    try {
      await pending
    } finally {
      if (closePromise === pending) closePromise = null
    }
  }

  async function restart() {
    await close()
    return start()
  }

  return Object.freeze({
    start,
    subscribe,
    close,
    restart,
    get active() { return Boolean(listener) },
    get subscriberCount() { return subscribers.size }
  })
}
