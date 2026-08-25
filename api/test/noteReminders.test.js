import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  getNoteRemindersForUser,
  isValidReminderId,
  mapNoteReminder,
  normalizeReminderLimit
} from '../src/lib/noteReminders.js'

async function readSource(relativeUrl) {
  return fs.readFile(new URL(relativeUrl, import.meta.url), 'utf8')
}

test('reminder limits are bounded and reminder ids are validated before PostgreSQL UUID casts', () => {
  assert.equal(normalizeReminderLimit(undefined), 50)
  assert.equal(normalizeReminderLimit('20'), 20)
  assert.equal(normalizeReminderLimit('1000'), 100)
  assert.equal(normalizeReminderLimit('-1'), 50)

  assert.equal(isValidReminderId('550e8400-e29b-41d4-a716-446655440000'), true)
  assert.equal(isValidReminderId('not-a-uuid'), false)
  assert.equal(isValidReminderId(''), false)
})

test('encrypted reminder DTOs expose no note body and use a generic title', () => {
  const reminder = mapNoteReminder({
    id: '550e8400-e29b-41d4-a716-446655440000',
    note_id: '550e8400-e29b-41d4-a716-446655440001',
    number_id: 1000,
    title: 'private deployment title',
    content: 'private deployment body',
    encrypted: true,
    due_at_snapshot: '2026-08-01T08:00:00.000Z',
    triggered_at: '2026-08-01T08:00:00.000Z',
    read_at: null
  })

  assert.deepEqual(Object.keys(reminder), [
    'id',
    'noteId',
    'numberId',
    'title',
    'encrypted',
    'dueAt',
    'reminderAt',
    'remindBeforeMinutes',
    'triggeredAt',
    'readAt'
  ])
  assert.equal(reminder.title, '加密备忘录')
  assert.equal(JSON.stringify(reminder).includes('private deployment'), false)
})

test('GET reminder transaction synchronizes due memos before returning unread state', async () => {
  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (/SELECT\s+reminder\.id/i.test(sql)) {
        return {
          rows: [{
            id: '550e8400-e29b-41d4-a716-446655440000',
            note_id: '550e8400-e29b-41d4-a716-446655440001',
            number_id: 1001,
            title: 'renew certificate',
            encrypted: false,
            due_at_snapshot: '2026-08-01T08:00:00.000Z',
            triggered_at: '2026-08-01T08:00:00.000Z',
            read_at: null
          }]
        }
      }
      if (/COUNT\(\*\)::integer/i.test(sql)) {
        return { rows: [{ count: 1 }] }
      }
      return { rows: [], rowCount: 0 }
    }
  }

  const result = await getNoteRemindersForUser('user-1', {
    limit: 10,
    transaction: async (callback) => callback(client)
  })

  assert.equal(result.reminders.length, 1)
  assert.equal(result.reminders[0].title, 'renew certificate')
  assert.equal(result.unreadCount, 1)
  assert.match(result.serverNow, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(calls.length, 5)
  assert.match(calls[0].sql, /FROM notes[\s\S]*ORDER BY id ASC[\s\S]*FOR UPDATE/i)
  assert.match(calls[1].sql, /DELETE FROM note_reminders/i)
  assert.match(calls[1].sql, /remind_before_minutes IS DISTINCT FROM reminder\.remind_before_minutes_snapshot/i)
  assert.match(calls[2].sql, /ON CONFLICT \(note_id, due_at_snapshot\) DO NOTHING/i)
  assert.match(calls[2].sql, /note\.completed = FALSE/i)
  assert.match(calls[2].sql, /remind_before_minutes \* INTERVAL '1 minute'\) <= NOW\(\)/i)
  assert.match(calls[3].sql, /LIMIT \$2/i)
  assert.match(calls[4].sql, /reminder\.read_at IS NULL/i)
  assert.match(calls[4].sql, /reminder_at_snapshot/i)
})

test('migration and routes persist read state, isolate users, and reject malformed reminder ids', async () => {
  const [migration, routes, notesRoute] = await Promise.all([
    readSource('../src/db/migrations/013_note_reminders.sql'),
    readSource('../src/routes/noteReminders.js'),
    readSource('../src/routes/notes.js')
  ])

  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/i)
  assert.match(migration, /REFERENCES notes\(id\) ON DELETE CASCADE/i)
  assert.match(migration, /UNIQUE \(note_id, due_at_snapshot\)/i)
  assert.match(migration, /WHERE read_at IS NULL/i)

  assert.match(routes, /fastify\.requireAuth/)
  assert.match(routes, /isValidReminderId\(request\.params\.reminderId\)/)
  assert.match(routes, /reply\.code\(400\)/)
  assert.match(routes, /markNoteReminderRead\(\s*request\.currentUser\.id/)
  assert.match(routes, /markAllNoteRemindersRead\(request\.currentUser\.id\)/)
  assert.match(notesRoute, /DELETE FROM note_reminders[\s\S]*WHERE note_id = \$1/)
})

test('browser notifications remain explicit opt-in and add authenticated Web Push delivery', async () => {
  const files = await Promise.all([
    readSource('../src/lib/noteReminders.js'),
    readSource('../src/routes/noteReminders.js'),
    readSource('../../app/src/shared/composables/useNoteReminders.js'),
    readSource('../../app/src/modules/whisper/components/ReminderCenter.vue'),
    readSource('../../app/src/shared/services/webPushApi.js'),
    readSource('../../app/src/shared/services/webPushSubscription.js'),
    readSource('../../app/public/sw.js'),
    readSource('../src/routes/webPush.js')
  ])
  const source = files.join('\n')

  assert.match(source, /Notification\.requestPermission\(\)/)
  assert.match(source, /notificationPermission/)
  assert.match(source, /registration\.showNotification\(title, options\)/)
  assert.match(source, /pushManager\.subscribe/)
  assert.match(source, /addEventListener\('push'/)
  assert.match(source, /fastify\.requireAuth/)
  assert.match(source, /web_push_subscriptions/)
  assert.doesNotMatch(source, /telegram|sendMessage/i)
  assert.match(source, /网页关闭后仍可送达|关闭网页后也能收到/)
})
