import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function source(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8')
}

test('server, config and Compose keep maintenance and logs bounded', async () => {
  const [server, app, config, envExample, compose] = await Promise.all([
    source('../src/server.js'),
    source('../src/app.js'),
    source('../src/config.js'),
    source('../.env.example'),
    source('../../docker-compose.backend.yml')
  ])

  assert.match(server, /startSecurityEventRetention/)
  assert.match(server, /startMediaDeleteRetry/)
  assert.match(server, /attemptMediaAssetDeletion/)
  assert.match(server, /await Promise\.all/)
  assert.match(config, /NAV_SECURITY_EVENT_RETENTION_ENABLED/)
  assert.match(config, /NAV_MEDIA_DELETE_RETRY_ENABLED/)
  assert.match(envExample, /NAV_SECURITY_EVENT_RETENTION_ENABLED=false/)
  assert.match(envExample, /NAV_MEDIA_DELETE_RETRY_ENABLED=false/)
  assert.match(app, /level: config\.apiLogLevel/)
  assert.match(app, /req\.headers\.authorization/)
  assert.match(app, /req\.headers\.cookie/)
  assert.match(app, /req\.body\.currentPassword/)
  assert.match(app, /req\.body\.recoveryCode/)
  assert.match(compose, /driver: local/)
  assert.match(compose, /max-size: "10m"/)
  assert.equal((compose.match(/logging: \*nav-logging/g) || []).length, 2)
})

test('routes expose retention, export and media retry status without secrets', async () => {
  const [securityRoute, mediaRoute, securityService, mediaService] = await Promise.all([
    source('../src/routes/securityEvents.js'),
    source('../src/routes/media.js'),
    source('../../app/src/shared/services/adminSecurityEventsApi.js'),
    source('../../app/src/shared/services/mediaApi.js')
  ])

  assert.match(securityRoute, /\/admin\/security-events\/export/)
  assert.match(securityRoute, /X-NAV-Export-Truncated/)
  assert.match(securityRoute, /securityEventRetentionPolicy/)
  assert.match(securityRoute, /admin\.security_events\.export/)
  assert.match(mediaRoute, /deleteRetry:/)
  assert.match(mediaRoute, /mediaDeleteRetryMaxAttempts/)
  assert.match(securityService, /exportAdminSecurityEvents/)
  assert.match(mediaService, /deleteRetry: payload\.deleteRetry/)
})

test('migration and verifier include the partial retry index', async () => {
  const [migration, verifier] = await Promise.all([
    source('../src/db/migrations/017_background_maintenance.sql'),
    source('../src/db/verifyMigrations.js')
  ])
  assert.match(migration, /idx_media_assets_delete_retry/)
  assert.match(migration, /WHERE retention = 'auto'/)
  assert.match(migration, /state IN \('delete_pending', 'delete_failed'\)/)
  assert.match(verifier, /idx_media_assets_delete_retry/)
})

test('admin and media surfaces explain automatic maintenance', async () => {
  const [auditUi, mediaUi, apiClient] = await Promise.all([
    source('../../app/src/modules/settings/components/SecurityAuditSettings.vue'),
    source('../../app/src/modules/media/MediaLibrary.vue'),
    source('../../app/src/shared/services/apiClient.js')
  ])
  assert.match(auditUi, /导出 CSV/)
  assert.match(auditUi, /在线审计保留策略/)
  assert.match(mediaUi, /mediaDeleteRetrySummary/)
  assert.match(mediaUi, /后台会按退避策略继续尝试/)
  assert.match(apiClient, /export async function apiFileRequest/)
})
