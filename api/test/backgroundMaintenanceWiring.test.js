import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function source(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8')
}

test('server, config and Compose keep maintenance and logs bounded', async () => {
  const [server, emailRuntime, app, config, envExample, compose] = await Promise.all([
    source('../src/server.js'),
    source('../src/lib/emailRuntimeController.js'),
    source('../src/app.js'),
    source('../src/config.js'),
    source('../.env.example'),
    source('../../docker-compose.backend.yml')
  ])

  assert.match(server, /startSecurityEventRetention/)
  assert.match(server, /startMediaDeleteRetry/)
  assert.match(server, /startAiUsageRetention/)
  assert.match(server, /startNoteReminderGeneration/)
  assert.match(server, /startBookmarkHealthScheduler/)
  assert.match(server, /startSearchEmbeddingScheduler/)
  assert.match(server, /startWebPushScheduler/)
  assert.match(server, /configureEmailRuntime/)
  assert.match(server, /stopEmailRuntime/)
  assert.match(emailRuntime, /startMailDeliveryScheduler/)
  assert.match(emailRuntime, /startEmailIngestWorker/)
  assert.match(emailRuntime, /startEmailSentAppendScheduler/)
  assert.match(emailRuntime, /startEmailCacheRetention/)
  assert.match(emailRuntime, /startEmailDigestScheduler/)
  assert.match(emailRuntime, /MAINTENANCE_JOB_NAMES\.MAIL_DELIVERY/)
  assert.match(server, /createMaintenanceJobObserver/)
  assert.match(server, /sendMaintenanceNotification/)
  assert.doesNotMatch(server, /sendMaintenanceJobNotificationToAdmins/)
  assert.match(server, /attemptMediaAssetDeletion/)
  assert.match(server, /await Promise\.all/)
  assert.match(config, /NAV_SECURITY_EVENT_RETENTION_ENABLED/)
  assert.match(config, /NAV_MEDIA_DELETE_RETRY_ENABLED/)
  assert.match(config, /NAV_AI_USAGE_RETENTION_ENABLED/)
  assert.match(config, /NAV_NOTE_REMINDER_SCHEDULER_ENABLED/)
  assert.match(config, /NAV_BOOKMARK_HEALTH_SCHEDULER_ENABLED/)
  assert.match(config, /NAV_MAINTENANCE_ALERTS_ENABLED/)
  assert.match(config, /NAV_EMBEDDING_SCHEDULER_ENABLED/)
  assert.match(config, /NAV_WEB_PUSH_SCHEDULER_ENABLED/)
  assert.match(config, /NAV_MAIL_DELIVERY_ENABLED/)
  assert.match(config, /NAV_EMAIL_RUNTIME_ROLE/)
  assert.match(config, /NAV_EMAIL_INGEST_ENABLED/)
  assert.match(config, /NAV_EMAIL_SENT_APPEND_ENABLED/)
  assert.match(config, /NAV_EMAIL_DIGEST_ENABLED/)
  assert.match(config, /NAV_EMAIL_CACHE_RETENTION_ENABLED/)
  assert.match(envExample, /NAV_SECURITY_EVENT_RETENTION_ENABLED=false/)
  assert.match(envExample, /NAV_MEDIA_DELETE_RETRY_ENABLED=false/)
  assert.match(envExample, /NAV_AI_USAGE_RETENTION_ENABLED=false/)
  assert.match(envExample, /NAV_NOTE_REMINDER_SCHEDULER_ENABLED=false/)
  assert.match(envExample, /NAV_BOOKMARK_HEALTH_SCHEDULER_ENABLED=false/)
  assert.match(envExample, /NAV_MAINTENANCE_ALERTS_ENABLED=false/)
  assert.match(envExample, /NAV_EMBEDDING_SCHEDULER_ENABLED=false/)
  assert.match(envExample, /NAV_WEB_PUSH_SCHEDULER_ENABLED=false/)
  assert.match(envExample, /NAV_MAIL_DELIVERY_ENABLED=false/)
  assert.match(envExample, /NAV_EMAIL_RUNTIME_ROLE=combined/)
  assert.match(envExample, /NAV_EMAIL_INGEST_ENABLED=false/)
  assert.match(envExample, /NAV_EMAIL_SENT_APPEND_ENABLED=false/)
  assert.match(envExample, /NAV_EMAIL_DIGEST_ENABLED=false/)
  assert.match(envExample, /NAV_EMAIL_CACHE_RETENTION_ENABLED=true/)
  assert.match(app, /level: config\.apiLogLevel/)
  assert.match(app, /req\.headers\.authorization/)
  assert.match(app, /req\.headers\.cookie/)
  assert.match(app, /req\.body\.currentPassword/)
  assert.match(app, /req\.body\.recoveryCode/)
  assert.match(app, /req\.body\.query/)
  assert.match(compose, /driver: local/)
  assert.match(compose, /max-size: "10m"/)
  assert.equal((compose.match(/logging: \*nav-logging/g) || []).length, 3)
})

test('production maintenance profile opts in only the two reviewed bounded jobs', async () => {
  const [profile, config, route] = await Promise.all([
    source('../../ops/env/nav-production-maintenance.env'),
    source('../src/config.js'),
    source('../src/routes/maintenance.js')
  ])

  assert.match(profile, /NAV_BOOKMARK_HEALTH_SCHEDULER_ENABLED=true/)
  assert.match(profile, /NAV_BOOKMARK_HEALTH_SCHEDULER_BATCH_SIZE=20/)
  assert.match(profile, /NAV_BOOKMARK_HEALTH_SCHEDULER_CONCURRENCY=2/)
  assert.match(profile, /NAV_AI_USAGE_RETENTION_ENABLED=true/)
  assert.match(profile, /NAV_AI_USAGE_RETENTION_DAYS=400/)
  assert.match(profile, /NAV_AI_USAGE_RETENTION_MAX_BATCHES_PER_RUN=4/)
  assert.doesNotMatch(profile, /SECRET|PASSWORD|TOKEN|API_KEY/)
  assert.match(config, /bookmarkHealthSchedulerEnabled/)
  assert.match(config, /aiUsageRetentionEnabled/)
  assert.match(route, /BOOKMARK_HEALTH_CHECK/)
  assert.match(route, /AI_USAGE_RETENTION/)
})

test('local timers cannot claim offsite backup and the release cleanup is bounded', async () => {
  const [
    backupUnit,
    retentionUnit,
    restoreUnit,
    enableGate,
    releaseLink,
    cleanup,
    backupConfig
  ] = await Promise.all([
    source('../../ops/systemd/nav-backup.service'),
    source('../../ops/systemd/nav-backup-retention.service'),
    source('../../ops/systemd/nav-restore-rehearsal.service'),
    source('../../scripts/enable-nav-local-backup-timers.sh'),
    source('../../scripts/nav-release-link.sh'),
    source('../../scripts/nav-controlled-cleanup.sh'),
    source('../../scripts/nav-backup.env.example')
  ])

  assert.match(backupUnit, /nav-backup --config \/etc\/nav\/nav-backup\.env\s*$/m)
  assert.doesNotMatch(backupUnit, /cloud-upload|restic|heartbeat/)
  assert.match(retentionUnit, /nav-backup --config \/etc\/nav\/nav-backup\.env --prune-local/)
  assert.doesNotMatch(retentionUnit, /cloud-upload|forget-cloud|restic|heartbeat/)
  assert.match(restoreUnit, /nav-restore-latest --config \/etc\/nav\/nav-backup\.env/)
  assert.doesNotMatch(restoreUnit, /nav-restore-cloud-latest|restic|heartbeat/)
  assert.match(enableGate, /NAV_ENABLE_CLOUD_UPLOAD/)
  assert.match(enableGate, /must remain false for the local-only timer profile/)
  assert.match(enableGate, /systemctl start nav-backup\.service/)
  assert.match(enableGate, /systemctl start nav-restore-rehearsal\.service/)
  assert.match(enableGate, /systemctl enable --now/)
  assert.match(releaseLink, /mv -Tf -- "\$TEMP_LINK" "\$destination"/)
  assert.match(releaseLink, /rollback requires verified current and rollback links/)
  assert.match(backupConfig, /NAV_RELEASE_LOCK_FILE=\/run\/lock\/nav-release-link\.lock/)
  assert.match(cleanup, /APPLY=false/)
  assert.match(cleanup, /current_target/)
  assert.match(cleanup, /rollback_target/)
  assert.match(cleanup, /--vacuum-time=30d|nav-log-retention/)
  assert.match(cleanup, /docker image prune --force --filter dangling=true/)
  assert.match(cleanup, /revision.*\^\[0-9a-f\].*40/)
  assert.doesNotMatch(cleanup, /docker (?:system|container|volume|network) prune/)
  assert.match(backupConfig, /NAV_PROJECT_DIR=\/opt\/nav-stack\/current/)
  assert.match(backupConfig, /NAV_DR_COMPOSE_PROJECT_DIR=\/opt\/nav-stack\/current/)
})

test('migration verification keeps all twelve maintenance jobs after feature integration', async () => {
  const [verifier, statusService, maintenanceRoute] = await Promise.all([
    source('../src/db/verifyMigrations.js'),
    source('../src/lib/maintenanceJobStatus.js'),
    source('../src/routes/maintenance.js')
  ])

  const expectedJobs = [
    'security_event_retention',
    'media_delete_retry',
    'ai_usage_retention',
    'note_reminder_generation',
    'bookmark_health_check',
    'search_embedding_index',
    'web_push_delivery',
    'mail_delivery',
    'email_ingest',
    'email_sent_append',
    'email_digest',
    'email_cache_retention'
  ]

  for (const job of expectedJobs) {
    assert.match(verifier, new RegExp(job))
    assert.match(statusService, new RegExp(job))
  }

  assert.match(maintenanceRoute, /AI_USAGE_RETENTION/)
  assert.match(maintenanceRoute, /NOTE_REMINDER_GENERATION/)
  assert.match(maintenanceRoute, /BOOKMARK_HEALTH_CHECK/)
  assert.match(maintenanceRoute, /EMAIL_CACHE_RETENTION/)
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
