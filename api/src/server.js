import { createApp } from './app.js'
import { ensureAdminUser } from './bootstrap.js'
import { config } from './config.js'
import { pool, runMigrations } from './db/index.js'
import { deleteImgBedUserImage } from './lib/imgBedLibraryClient.js'
import { startAiUsageRetention } from './lib/aiUsageRetention.js'
import { attemptMediaAssetDeletion } from './lib/mediaAssets.js'
import { startBookmarkHealthScheduler } from './lib/bookmarkHealthScheduler.js'
import { startMediaDeleteRetry } from './lib/mediaDeleteRetry.js'
import {
  createMaintenanceJobObserver,
  MAINTENANCE_JOB_NAMES
} from './lib/maintenanceJobStatus.js'
import { configureOutboundNetwork } from './lib/network.js'
import { validatePersistentRateLimitConfiguration } from './lib/persistentRateLimit.js'
import { startSecurityEventRetention } from './lib/securityEventRetention.js'
import { startNoteReminderGeneration } from './lib/noteReminderScheduler.js'
import { startSearchEmbeddingScheduler } from './lib/searchEmbeddingScheduler.js'
import { startWebPushScheduler } from './lib/webPushScheduler.js'
import { sendMaintenanceJobNotificationToAdmins } from './lib/telegram.js'
import { attachCollaborationWebSocket } from './lib/collaborationWebSocket.js'
import {
  recoverExpiredReleaseAcceptanceAccounts,
  startReleaseAcceptanceAccountRecovery
} from './ops/releaseAcceptanceAccount.js'

configureOutboundNetwork()

async function main() {
  validatePersistentRateLimitConfiguration()
  await runMigrations()
  const initialAcceptanceRecovery = await recoverExpiredReleaseAcceptanceAccounts({
    poolInstance: pool
  })
  await ensureAdminUser()

  const app = createApp()
  const stopCollaborationWebSocket = await attachCollaborationWebSocket(app.server, app.log)
  let stopSecurityEventRetention = async () => {}
  let stopMediaDeleteRetry = async () => {}
  let stopAiUsageRetention = async () => {}
  let stopNoteReminderGeneration = async () => {}
  let stopBookmarkHealthScheduler = async () => {}
  let stopSearchEmbeddingScheduler = async () => {}
  let stopWebPushScheduler = async () => {}
  let stopReleaseAcceptanceRecovery = async () => {}
  let closing = false

  if (initialAcceptanceRecovery.cleanedCount > 0) {
    app.log.warn(
      { cleanedCount: initialAcceptanceRecovery.cleanedCount },
      'expired release acceptance account recovered during startup'
    )
  }
  if (initialAcceptanceRecovery.failedCount > 0) {
    app.log.error(
      {
        failedCount: initialAcceptanceRecovery.failedCount,
        failures: initialAcceptanceRecovery.failures
      },
      'release acceptance account recovery requires operator review'
    )
  }

  const close = async () => {
    if (closing) return
    closing = true
    await Promise.all([
      stopSecurityEventRetention(),
      stopMediaDeleteRetry(),
      stopAiUsageRetention(),
      stopNoteReminderGeneration(),
      stopBookmarkHealthScheduler(),
      stopSearchEmbeddingScheduler(),
      stopWebPushScheduler(),
      stopReleaseAcceptanceRecovery(),
      stopCollaborationWebSocket()
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

    stopAiUsageRetention = startAiUsageRetention({
      enabled: config.aiUsageRetentionEnabled,
      policy: {
        retentionDays: config.aiUsageRetentionDays,
        intervalSeconds: config.aiUsageRetentionIntervalSeconds,
        batchSize: config.aiUsageRetentionBatchSize,
        maxBatchesPerRun: config.aiUsageRetentionMaxBatchesPerRun
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.AI_USAGE_RETENTION,
        jobLabel: 'AI 用量定期清理'
      })
    })

    stopNoteReminderGeneration = startNoteReminderGeneration({
      enabled: config.noteReminderSchedulerEnabled,
      policy: {
        intervalSeconds: config.noteReminderSchedulerIntervalSeconds,
        batchSize: config.noteReminderSchedulerBatchSize
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.NOTE_REMINDER_GENERATION,
        jobLabel: '提前提醒生成'
      })
    })

    stopBookmarkHealthScheduler = startBookmarkHealthScheduler({
      enabled: config.bookmarkHealthSchedulerEnabled,
      policy: {
        intervalSeconds: config.bookmarkHealthSchedulerIntervalSeconds,
        batchSize: config.bookmarkHealthSchedulerBatchSize,
        staleHours: config.bookmarkHealthSchedulerStaleHours,
        concurrency: config.bookmarkHealthSchedulerConcurrency
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.BOOKMARK_HEALTH_CHECK,
        jobLabel: '书签定时失效检查'
      })
    })

    stopSearchEmbeddingScheduler = startSearchEmbeddingScheduler({
      enabled: config.semanticSearchEnabled && config.embeddingSchedulerEnabled,
      policy: {
        intervalSeconds: config.embeddingSchedulerIntervalSeconds,
        batchSize: config.embeddingSchedulerBatchSize
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.SEARCH_EMBEDDING_INDEX,
        jobLabel: '本地语义索引'
      })
    })

    stopWebPushScheduler = startWebPushScheduler({
      enabled: config.webPushEnabled && config.webPushSchedulerEnabled,
      policy: {
        intervalSeconds: config.webPushSchedulerIntervalSeconds,
        batchSize: config.webPushSchedulerBatchSize,
        maxAttempts: config.webPushMaxAttempts
      },
      poolInstance: pool,
      logger: app.log,
      observer: createMaintenanceJobObserver({
        ...observerOptions,
        jobName: MAINTENANCE_JOB_NAMES.WEB_PUSH_DELIVERY,
        jobLabel: '后台到期提醒推送'
      })
    })

    stopReleaseAcceptanceRecovery = startReleaseAcceptanceAccountRecovery({
      poolInstance: pool,
      logger: app.log
    })
  } catch (error) {
    await Promise.all([
      stopSecurityEventRetention(),
      stopMediaDeleteRetry(),
      stopAiUsageRetention(),
      stopNoteReminderGeneration(),
      stopBookmarkHealthScheduler(),
      stopSearchEmbeddingScheduler(),
      stopWebPushScheduler(),
      stopReleaseAcceptanceRecovery(),
      stopCollaborationWebSocket()
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
