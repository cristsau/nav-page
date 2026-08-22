import { createApp } from './app.js'
import { ensureAdminUser } from './bootstrap.js'
import { config } from './config.js'
import { pool, runMigrations } from './db/index.js'
import { deleteImgBedUserImage } from './lib/imgBedLibraryClient.js'
import { attemptMediaAssetDeletion } from './lib/mediaAssets.js'
import { startMediaDeleteRetry } from './lib/mediaDeleteRetry.js'
import {
  createMaintenanceJobObserver,
  MAINTENANCE_JOB_NAMES
} from './lib/maintenanceJobStatus.js'
import { configureOutboundNetwork } from './lib/network.js'
import { validatePersistentRateLimitConfiguration } from './lib/persistentRateLimit.js'
import { startSecurityEventRetention } from './lib/securityEventRetention.js'
import { sendMaintenanceJobNotificationToAdmins } from './lib/telegram.js'

configureOutboundNetwork()

async function main() {
  validatePersistentRateLimitConfiguration()
  await runMigrations()
  await ensureAdminUser()

  const app = createApp()
  let stopSecurityEventRetention = async () => {}
  let stopMediaDeleteRetry = async () => {}
  let closing = false

  const close = async () => {
    if (closing) return
    closing = true
    await Promise.all([
      stopSecurityEventRetention(),
      stopMediaDeleteRetry()
    ])
    await app.close()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGINT', close)
  process.on('SIGTERM', close)

  try {
    await app.listen({
      host: config.host,
      port: config.port
    })

    const observerOptions = {
      poolInstance: pool,
      logger: app.log,
      alertsEnabled: config.maintenanceAlertsEnabled,
      failureThreshold: config.maintenanceAlertFailureThreshold,
      alertCooldownSeconds: config.maintenanceAlertCooldownSeconds,
      notifyFn: sendMaintenanceJobNotificationToAdmins
    }

    stopSecurityEventRetention = startSecurityEventRetention({
      enabled: config.securityEventRetentionEnabled,
      policy: {
        routineDays: config.securityEventRoutineRetentionDays,
        deniedDays: config.securityEventDeniedRetentionDays,
        criticalDays: config.securityEventCriticalRetentionDays,
        intervalSeconds: config.securityEventRetentionIntervalSeconds,
        batchSize: config.securityEventRetentionBatchSize,
        maxBatchesPerRun: config.securityEventRetentionMaxBatchesPerRun
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.SECURITY_EVENT_RETENTION,
        jobLabel: '安全审计定期清理'
      })
    })

    stopMediaDeleteRetry = startMediaDeleteRetry({
      enabled: config.mediaDeleteRetryEnabled,
      policy: {
        intervalSeconds: config.mediaDeleteRetryIntervalSeconds,
        batchSize: config.mediaDeleteRetryBatchSize,
        maxAttempts: config.mediaDeleteRetryMaxAttempts,
        baseBackoffSeconds: config.mediaDeleteRetryBaseBackoffSeconds,
        maxBackoffSeconds: config.mediaDeleteRetryMaxBackoffSeconds
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
        jobLabel: '图床删除失败重试'
      }),
      retryFn: ({ id, userId }) => attemptMediaAssetDeletion(
        userId,
        id,
        deleteImgBedUserImage,
        null,
        { requireAuto: true, requirePending: true }
      )
    })
  } catch (error) {
    await Promise.all([
      stopSecurityEventRetention(),
      stopMediaDeleteRetry()
    ])
    await app.close()
    throw error
  }
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
