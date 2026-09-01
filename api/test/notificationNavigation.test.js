import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { resolveNotificationDestination } from '../../app/src/shared/navigation/notificationNavigation.js'

const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'
const LOCATION_ID = '44444444-4444-4444-8444-444444444444'

test('mail notification opens its canonical mailbox location when hydration provides it', () => {
  assert.deepEqual(resolveNotificationDestination({
    sourceType: 'email',
    sourceId: EVENT_ID,
    actionUrl: `/assistant?email=${EVENT_ID}`,
    detail: {
      id: EVENT_ID,
      accountId: ACCOUNT_ID,
      folderId: FOLDER_ID,
      locationId: LOCATION_ID
    }
  }), {
    path: '/mail',
    query: { account: ACCOUNT_ID, folder: FOLDER_ID, message: LOCATION_ID }
  })
})

test('mail notification falls back to the mail legacy-event deep link', () => {
  assert.deepEqual(resolveNotificationDestination({
    sourceType: 'email',
    sourceId: EVENT_ID,
    actionUrl: `/assistant?email=${EVENT_ID}`
  }), {
    path: '/mail',
    query: { email: EVENT_ID }
  })
})

test('historical assistant email actions and digest notifications cannot reopen assistant', () => {
  assert.deepEqual(resolveNotificationDestination({
    actionUrl: `/assistant?email=${EVENT_ID}`
  }), { path: '/mail', query: { email: EVENT_ID } })
  assert.deepEqual(resolveNotificationDestination({
    sourceType: 'email_digest',
    actionUrl: '/assistant?view=email',
    metadata: { emailEventIds: [EVENT_ID] }
  }), { path: '/mail', query: { email: EVENT_ID } })
})

test('digest notifications prefer a hydrated canonical mailbox location', () => {
  assert.deepEqual(resolveNotificationDestination({
    sourceType: 'email_digest',
    metadata: { emailEventIds: [EVENT_ID] },
    detail: {
      emails: [{
        id: EVENT_ID,
        accountId: ACCOUNT_ID,
        folderId: FOLDER_ID,
        locationId: LOCATION_ID
      }]
    }
  }), {
    path: '/mail',
    query: { account: ACCOUNT_ID, folder: FOLDER_ID, message: LOCATION_ID }
  })
})

test('unrelated internal notification routes are preserved', () => {
  assert.equal(resolveNotificationDestination({ actionUrl: '/whisper?note=123' }), '/whisper?note=123')
  assert.equal(resolveNotificationDestination({ actionUrl: 'https://example.test/phish' }), null)
})

test('notification center exposes a persistent one-click read-all control with failure handling', async () => {
  const source = await readFile(
    new URL('../../app/src/shared/components/NotificationCenter.vue', import.meta.url),
    'utf8'
  )
  assert.match(source, /markAllNotificationsRead\(\)/)
  assert.match(source, /一键已读/)
  assert.match(source, /:disabled="!unreadCount \|\| markingAll"/)
  assert.match(source, /通知一键已读失败/)
})

test('notification navigation is not blocked when the best-effort read update fails', async () => {
  const source = await readFile(
    new URL('../../app/src/shared/components/NotificationCenter.vue', import.meta.url),
    'utf8'
  )
  const destinationIndex = source.indexOf('const destination = resolveNotificationDestination(item)')
  const readIndex = source.indexOf('void markNotificationRead(item.id).catch')
  const pushIndex = source.indexOf('await router.push(destination)')
  assert.ok(destinationIndex >= 0)
  assert.ok(readIndex > destinationIndex)
  assert.ok(pushIndex > readIndex)
  assert.doesNotMatch(source, /await markNotificationRead\(item\.id\)/)
})

test('new email notification records point at mail instead of assistant', async () => {
  const [events, digest] = await Promise.all([
    readFile(new URL('../src/lib/emailEvents.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/emailDigestScheduler.js', import.meta.url), 'utf8')
  ])
  assert.match(events, /actionUrl: `\/mail\?email=\$\{encodeURIComponent\(row\.id\)\}`/)
  assert.doesNotMatch(events, /actionUrl: `\/assistant\?email=/)
  assert.match(events, /href: `\/mail\?email=\$\{encodeURIComponent\(row\.id\)\}`/)
  assert.doesNotMatch(events, /href: `\/assistant\?email=/)
  assert.match(events, /event\.email_message_id, message\.account_id/)
  assert.match(events, /candidate\.id AS location_id/)
  assert.match(events, /accountId: row\.account_id \|\| null/)
  assert.match(digest, /actionUrl: '\/mail'/)
  assert.doesNotMatch(digest, /actionUrl: '\/assistant\?view=email'/)
})
