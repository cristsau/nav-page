import assert from 'node:assert/strict'
import test from 'node:test'
import { subscribeToCollaborationEvents } from '../../app/src/shared/services/collaborationEvents.js'

const NOTE_ID = '44444444-4444-4444-8444-444444444444'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event)
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code, reason })
  }
}

test('collaboration event client reports readiness, validates events and stops after access revocation', () => {
  const previousWindow = globalThis.window
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const windowListeners = new Map()
  FakeWebSocket.instances = []

  globalThis.window = {
    location: { origin: 'https://nav.example.test' },
    WebSocket: FakeWebSocket,
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) { windowListeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (windowListeners.get(type) === listener) windowListeners.delete(type)
    }
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  })

  const statuses = []
  const events = []
  let unsubscribe
  try {
    unsubscribe = subscribeToCollaborationEvents(NOTE_ID, {
      onStatus: (status) => statuses.push(status),
      onEvent: (event) => events.push(event)
    })
    const socket = FakeWebSocket.instances[0]
    assert.ok(socket)
    assert.equal(socket.url, `wss://nav.example.test/api/collaboration/events/${NOTE_ID}`)
    assert.deepEqual(statuses, ['connecting'])

    socket.readyState = FakeWebSocket.OPEN
    socket.emit('open')
    socket.emit('message', { data: JSON.stringify({ type: 'ready', noteId: NOTE_ID }) })
    assert.equal(statuses.at(-1), 'connected')

    socket.emit('message', {
      data: JSON.stringify({
        type: 'note-sync',
        cursor: '123',
        noteId: NOTE_ID,
        eventKind: 'comment.upsert',
        entityId: '55555555-5555-4555-8555-555555555555'
      })
    })
    socket.emit('message', { data: JSON.stringify({ type: 'note-sync', cursor: 'bad', noteId: NOTE_ID }) })
    assert.equal(events.length, 1)
    assert.equal(events[0].eventKind, 'comment.upsert')

    socket.close(1008, 'Collaboration access changed')
    assert.equal(statuses.at(-1), 'access-changed')
    assert.equal(FakeWebSocket.instances.length, 1)
  } finally {
    unsubscribe?.()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else delete globalThis.navigator
  }
})
