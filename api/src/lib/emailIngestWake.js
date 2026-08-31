import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'

export const EMAIL_INGEST_WAKE_CHANNEL = 'nav_email_ingest_wake'
export const EMAIL_CLASSIFICATION_WAKE_CHANNEL = 'nav_email_classification_wake'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SOURCE_KEY_PATTERN = /^[a-z0-9_.-]{1,80}$/

function quoteChannel(channel) {
  if (![EMAIL_INGEST_WAKE_CHANNEL, EMAIL_CLASSIFICATION_WAKE_CHANNEL].includes(channel)) {
    throw new TypeError('Email wake channel is invalid')
  }
  return `"${channel}"`
}

export function parseEmailWakePayload(payload) {
  try {
    const parsed = JSON.parse(String(payload || ''))
    const accountId = String(parsed?.accountId || '').trim().toLowerCase()
    const sourceKey = String(parsed?.sourceKey || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(accountId) || !SOURCE_KEY_PATTERN.test(sourceKey)) return null
    return { accountId, sourceKey }
  } catch {
    return null
  }
}

export async function notifyEmailWake(queryFn, channel, payload) {
  const accountId = String(payload?.accountId || '').trim().toLowerCase()
  const sourceKey = String(payload?.sourceKey || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(accountId) || !SOURCE_KEY_PATTERN.test(sourceKey)) {
    throw new TypeError('Email wake payload is invalid')
  }
  await queryFn('SELECT pg_notify($1, $2)', [
    channel,
    JSON.stringify({ accountId, sourceKey })
  ])
}

export function startEmailWakeListener({
  poolInstance,
  channel,
  onWake,
  logger,
  timerApi = globalThis
}) {
  if (!poolInstance?.connect) throw new TypeError('PostgreSQL pool is required')
  if (typeof onWake !== 'function') throw new TypeError('Email wake callback is required')
  const quotedChannel = quoteChannel(channel)
  let stopped = false
  let activeClient = null
  let activeRelease = null
  let connectPromise = null
  let reconnectTimer = null
  let reconnectAttempt = 0

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5)))
    reconnectAttempt += 1
    reconnectTimer = timerApi.setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
    reconnectTimer?.unref?.()
  }

  const connect = () => {
    if (stopped || activeClient || connectPromise) return connectPromise
    connectPromise = Promise.resolve()
      .then(() => poolInstance.connect())
      .then(async (candidate) => {
        let released = false
        const removeListeners = () => {
          candidate.off?.('notification', handleNotification)
          candidate.off?.('error', handleLoss)
          candidate.off?.('end', handleLoss)
        }
        const release = (error = null) => {
          if (released) return
          released = true
          removeListeners()
          if (activeClient === candidate) {
            activeClient = null
            activeRelease = null
          }
          try { candidate.release?.(error instanceof Error ? error : undefined) } catch {}
        }
        const handleNotification = (notification) => {
          if (notification?.channel !== channel) return
          const parsed = parseEmailWakePayload(notification.payload)
          if (!parsed) return
          try { onWake(parsed) } catch (error) {
            logger?.warn?.(
              { errorCode: sanitizeMaintenanceErrorCode(error) },
              'email wake callback failed'
            )
          }
        }
        const handleLoss = (error) => {
          release(error)
          scheduleReconnect()
        }
        candidate.on?.('notification', handleNotification)
        candidate.on?.('error', handleLoss)
        candidate.on?.('end', handleLoss)
        try {
          await candidate.query(`LISTEN ${quotedChannel}`)
          if (stopped) {
            try { await candidate.query(`UNLISTEN ${quotedChannel}`) } catch {}
            release()
            return
          }
          activeClient = candidate
          activeRelease = release
          reconnectAttempt = 0
        } catch (error) {
          release(error)
          throw error
        }
      })
      .catch((error) => {
        logger?.warn?.(
          { errorCode: sanitizeMaintenanceErrorCode(error) },
          'email wake listener is unavailable; bounded polling remains active'
        )
        scheduleReconnect()
      })
      .finally(() => { connectPromise = null })
    return connectPromise
  }

  void connect()
  return async () => {
    stopped = true
    if (reconnectTimer) timerApi.clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (connectPromise) await connectPromise
    const client = activeClient
    const release = activeRelease
    activeClient = null
    activeRelease = null
    if (!client) return
    try { await client.query(`UNLISTEN ${quotedChannel}`) } catch {}
    if (release) release()
    else try { client.release?.() } catch {}
  }
}
