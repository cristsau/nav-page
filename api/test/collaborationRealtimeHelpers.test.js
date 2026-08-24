import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canDeliverNoteSyncEvent,
  parseNoteSyncNotification
} from '../src/lib/collaborationWebSocket.js'

const NOTE_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '11111111-1111-4111-8111-111111111111'

test('note sync notifications accept only bounded identifiers', () => {
  assert.deepEqual(
    parseNoteSyncNotification(JSON.stringify({ eventId: '42', noteId: NOTE_ID })),
    { eventId: '42', noteId: NOTE_ID }
  )
  assert.equal(parseNoteSyncNotification('{bad-json'), null)
  assert.equal(parseNoteSyncNotification(JSON.stringify({ eventId: '-1', noteId: NOTE_ID })), null)
  assert.equal(parseNoteSyncNotification(JSON.stringify({ eventId: '99999999999999999999', noteId: NOTE_ID })), null)
  assert.equal(parseNoteSyncNotification(JSON.stringify({ eventId: '42', noteId: 'not-a-note' })), null)
})

test('note sync delivery requires both exact note and audience membership', () => {
  const event = {
    note_id: NOTE_ID,
    event_kind: 'comment.upsert',
    entity_id: '55555555-5555-4555-8555-555555555555',
    audience_user_ids: [USER_ID]
  }
  assert.equal(canDeliverNoteSyncEvent(event, USER_ID, NOTE_ID), true)
  assert.equal(canDeliverNoteSyncEvent(event, '22222222-2222-4222-8222-222222222222', NOTE_ID), false)
  assert.equal(canDeliverNoteSyncEvent(event, USER_ID, '33333333-3333-4333-8333-333333333333'), false)
})

test('note deletion events use the deleted entity id without widening audience', () => {
  const event = {
    note_id: null,
    event_kind: 'note.delete',
    entity_id: NOTE_ID,
    audience_user_ids: [USER_ID]
  }
  assert.equal(canDeliverNoteSyncEvent(event, USER_ID, NOTE_ID), true)
  assert.equal(canDeliverNoteSyncEvent(event, '22222222-2222-4222-8222-222222222222', NOTE_ID), false)
})
