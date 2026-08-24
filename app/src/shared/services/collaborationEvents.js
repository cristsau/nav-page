const NOTE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const MAX_RECONNECT_DELAY_MS = 30_000

function eventSocketUrl(noteId) {
  const url = new URL(
    `/api/collaboration/events/${encodeURIComponent(noteId)}`,
    window.location.origin
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function parseEventMessage(value, noteId) {
  try {
    const event = JSON.parse(String(value || ''))
    if (event?.type === 'ready' && event.noteId === noteId) return event
    if (
      event?.type !== 'note-sync'
      || event.noteId !== noteId
      || !/^\d+$/.test(String(event.cursor || ''))
      || typeof event.eventKind !== 'string'
    ) return null
    return event
  } catch {
    return null
  }
}

export function subscribeToCollaborationEvents(noteId, {
  onEvent = () => {},
  onStatus = () => {}
} = {}) {
  const normalizedNoteId = String(noteId || '').trim()
  if (!NOTE_ID_PATTERN.test(normalizedNoteId) || typeof window.WebSocket !== 'function') {
    onStatus('unsupported')
    return () => {}
  }

  let socket = null
  let reconnectTimer = null
  let readyTimer = null
  let reconnectAttempt = 0
  let stopped = false

  const setStatus = (status) => {
    if (!stopped) onStatus(status)
  }

  const clearReconnect = () => {
    if (reconnectTimer) window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const clearReadyTimer = () => {
    if (readyTimer) window.clearTimeout(readyTimer)
    readyTimer = null
  }

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer || !navigator.onLine) return
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * (2 ** Math.min(reconnectAttempt, 5)))
    reconnectAttempt += 1
    setStatus('reconnecting')
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  const connect = () => {
    if (stopped) return
    if (!navigator.onLine) {
      setStatus('offline')
      return
    }
    if (
      socket
      && [window.WebSocket.CONNECTING, window.WebSocket.OPEN].includes(socket.readyState)
    ) return

    clearReconnect()
    setStatus(reconnectAttempt ? 'reconnecting' : 'connecting')
    const nextSocket = new window.WebSocket(eventSocketUrl(normalizedNoteId))
    socket = nextSocket

    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket || stopped) return
      clearReadyTimer()
      readyTimer = window.setTimeout(() => {
        if (socket === nextSocket && nextSocket.readyState === window.WebSocket.OPEN) {
          nextSocket.close(1011, 'Realtime handshake timeout')
        }
      }, 8_000)
    })
    nextSocket.addEventListener('message', (message) => {
      if (socket !== nextSocket || stopped) return
      const event = parseEventMessage(message.data, normalizedNoteId)
      if (!event) return
      if (event.type === 'ready') {
        clearReadyTimer()
        reconnectAttempt = 0
        setStatus('connected')
        return
      }
      onEvent(event)
    })
    nextSocket.addEventListener('error', () => {
      if (socket === nextSocket && !stopped) setStatus('reconnecting')
    })
    nextSocket.addEventListener('close', (event) => {
      if (socket !== nextSocket) return
      clearReadyTimer()
      socket = null
      if (stopped) return
      if (event.code === 1008) {
        setStatus('access-changed')
        return
      }
      scheduleReconnect()
    })
  }

  const handleOnline = () => connect()
  const handleOffline = () => {
    clearReconnect()
    clearReadyTimer()
    setStatus('offline')
    socket?.close(1000, 'Offline')
  }

  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  connect()

  return () => {
    stopped = true
    clearReconnect()
    clearReadyTimer()
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
    const current = socket
    socket = null
    if (current && current.readyState < window.WebSocket.CLOSING) {
      current.close(1000, 'Panel closed')
    }
  }
}
