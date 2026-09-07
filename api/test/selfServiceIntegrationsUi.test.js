import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { recordSecurityEventBestEffort } from '../src/lib/securityEvents.js'

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('admin integrations expose write-only email and cloud backup configuration', async () => {
  const [route, managed, app, compose, securityEvents] = await Promise.all([
    source('../src/routes/integrations.js'),
    source('../src/lib/managedIntegrations.js'),
    source('../src/app.js'),
    source('../../docker-compose.backend.yml'),
    source('../src/lib/securityEvents.js')
  ])
  assert.match(route, /requireAdmin/)
  assert.match(route, /test-smtp/)
  assert.match(route, /test-imap/)
  assert.match(route, /cloud-backup\/test/)
  assert.match(route, /withManagedIntegrationMutation/)
  assert.match(route, /resourceId: null/)
  assert.doesNotMatch(route, /resourceId: resourceType/)
  assert.match(managed, /atomicWrite/)
  assert.match(managed, /0o600/)
  assert.match(managed, /smtpPasswordConfigured/)
  assert.doesNotMatch(managed, /return\s+\{[^}]*smtpPassword\s*:/s)
  assert.match(app, /req\.body\.secretAccessKey/)
  assert.match(compose, /NAV_MANAGED_INTEGRATIONS_DIR/)
  assert.match(compose, /NAV_INTEGRATIONS_DIR/)
  for (const eventType of [
    'admin.integrations.mail.updated',
    'admin.integrations.mail.smtp_tested',
    'admin.integrations.mail.imap_tested',
    'admin.integrations.cloud_backup.updated',
    'admin.integrations.cloud_backup.tested'
  ]) {
    assert.match(securityEvents, new RegExp(eventType.replaceAll('.', '\\.')))
  }
})

test('integration audit records a typed resource without an invalid UUID resource id', async () => {
  let loggedFailure = false
  const logger = { error() { loggedFailure = true } }
  const client = {
    async query(_sql, values) {
      assert.equal(values[4], 'mail_integration')
      assert.equal(values[5], null)
      return { rows: [{ id: 'audit-id', created_at: new Date().toISOString() }] }
    }
  }

  const recorded = await recordSecurityEventBestEffort({
    client,
    eventType: 'admin.integrations.mail.smtp_tested',
    outcome: 'success',
    resourceType: 'mail_integration',
    resourceId: null,
    affectedCount: 1
  }, logger)

  assert.equal(recorded, true)
  assert.equal(loggedFailure, false)
})

test('settings separate identity, transactional notifications and cloud backups', async () => {
  const [settings, component, mail, service, documentation] = await Promise.all([
    source('../../app/src/modules/settings/Settings.vue'),
    source('../../app/src/modules/settings/components/SystemIntegrationsSettings.vue'),
    source('../../app/src/modules/settings/components/SystemNotificationSettings.vue'),
    source('../../app/src/shared/services/integrationApi.js'),
    source('../../docs/NAV_SELF_SERVICE_INTEGRATIONS.md')
  ])
  assert.match(settings, /登录与系统集成/)
  assert.match(component, /OauthIntegrationSettings/)
  assert.match(component, /SystemNotificationSettings/)
  assert.match(component, /只读测试存储/)
  assert.match(component, /cloud\.enabled = false/)
  assert.match(component, /scrollIntoView/)
  assert.match(mail, /watch\(fingerprint/)
  assert.match(mail, /form\.deliveryEnabled = false/)
  assert.match(mail, /type="password"/)
  assert.match(service, /\/admin\/integrations\/cloud-backup/)
  assert.match(documentation, /Web\/API 进程不会执行 root 备份或恢复/)
})
