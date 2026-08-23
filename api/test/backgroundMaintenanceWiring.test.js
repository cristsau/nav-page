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
  assert.match(server, /startAiUsageRetention/)
  assert.match(server, /createMaintenanceJobObserver/)
  assert.match(server, /sendMaintenanceJobNotificationToAdmins/)
  assert.match(server, /attemptMediaAssetDeletion/)
  assert.match(server, /await Promise\.all/)
  assert.match(config, /NAV_SECURITY_EVENT_RETENTION_ENABLED/)
  assert.match(config, /NAV_MEDIA_DELETE_RETRY_ENABLED/)
  assert.match(config, /NAV_AI_USAGE_RETENTION_ENABLED/)
  assert.match(config, /NAV_MAINTENANCE_ALERTS_ENABLED/)
  assert.match(envExample, /NAV_SECURITY_EVENT_RETENTION_ENABLED=false/)
  assert.match(envExample, /NAV_MEDIA_DELETE_RETRY_ENABLED=false/)
  assert.match(envExample, /NAV_AI_USAGE_RETENTION_ENABLED=false/)
  assert.match(envExample, /NAV_MAINTENANCE_ALERTS_ENABLED=false/)
  assert.match(app, /level: config\.apiLogLevel/)
  assert.match(app, /req\.headers\.authorization/)
  assert.match(app, /req\.headers\.cookie/)
  assert.match(app, /req\.body\.currentPassword/)
  assert.match(app, /req\.body\.recoveryCode/)
  assert.match(app, /req\.body\.query/)
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

test('AI usage aggregation has a bounded retention migration and verifier', async () => {
  const [migration, verifier, retention] = await Promise.all([
    source('../src/db/migrations/021_ai_usage.sql'),
    source('../src/db/verifyMigrations.js'),
    source('../src/lib/aiUsageRetention.js')
  ])
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_usage_daily/)
  assert.match(migration, /ai_usage_retention/)
  assert.match(verifier, /verifyAiUsageSchema/)
  assert.match(retention, /FOR UPDATE SKIP LOCKED/)
  assert.match(retention, /maxBatchesPerRun/)
})

test('maintenance observability is additive, bounded and admin-only', async () => {
  const [migration, verifier, app, route, statusService, auditUi] = await Promise.all([
    source('../src/db/migrations/018_maintenance_observability.sql'),
    source('../src/db/verifyMigrations.js'),
    source('../src/app.js'),
    source('../src/routes/maintenance.js'),
    source('../../app/src/shared/services/adminMaintenanceApi.js'),
    source('../../app/src/modules/settings/components/SecurityAuditSettings.vue')
  ])

  assert.match(migration, /CREATE TABLE IF NOT EXISTS maintenance_job_status/)
  assert.match(migration, /last_result JSONB/)
  assert.match(migration, /consecutive_failures/)
  assert.match(migration, /last_notification_status/)
  assert.match(verifier, /verifyMaintenanceObservabilitySchema/)
  assert.match(app, /app\.register\(maintenanceRoutes/)
  assert.match(route, /requireAdmin/)
  assert.match(route, /private, no-store/)
  assert.match(statusService, /\/admin\/maintenance\/status/)
  assert.match(auditUi, /后台维护状态/)
  assert.match(auditUi, /外部 dead-man 监控/)
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
