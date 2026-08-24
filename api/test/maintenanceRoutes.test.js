import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

test('admin maintenance status route is private, admin-only and exposes no secret fields', async () => {
  const [route, service] = await Promise.all([
    fs.readFile(new URL('../src/routes/maintenance.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/shared/services/adminMaintenanceApi.js', import.meta.url), 'utf8')
  ])

  assert.match(route, /\/admin\/maintenance\/status/)
  assert.match(route, /requireAdmin/)
  assert.match(route, /Cache-Control', 'private, no-store/)
  assert.match(route, /FROM maintenance_job_status/)
  assert.match(route, /consecutiveFailures/)
  assert.match(route, /lastNotificationStatus/)
  assert.match(route, /NOTE_REMINDER_GENERATION/)
  assert.match(route, /BOOKMARK_HEALTH_CHECK/)
  assert.doesNotMatch(route, /botToken|adminChatId|exception_message|stack/)
  assert.match(service, /\/admin\/maintenance\/status/)
  assert.match(service, /cache: 'no-store'/)
})
