import { config } from '../config.js'
import { startEmailCacheRetention } from './emailRetention.js'
import { startEmailDigestScheduler } from './emailDigestScheduler.js'
import { startEmailIngestWorker } from './emailIngestWorker.js'
import { startEmailClassificationScheduler } from './emailClassificationWorker.js'
import { startEmailSentAppendScheduler } from './emailSentAppend.js'
import { startEmailRemoteCommandScheduler } from './emailRemoteCommandWorker.js'
import { MAINTENANCE_JOB_NAMES } from './maintenanceJobStatus.js'
import { startMailDeliveryScheduler } from './mailOutbox.js'
import { managedMailRuntimeConfigs } from './managedIntegrations.js'
import {
  createRecoverableSerialQueue,
  startRuntimeFunctions,
  stopRuntimeFunctions
} from './runtimeLifecycle.js'

let runtimeContext = null
let stopFunctions = []
const reconfigureQueue = createRecoverableSerialQueue()

async function stopCurrent() {
  const current = stopFunctions
  stopFunctions = []
  await stopRuntimeFunctions(current)
}

async function startCurrent() {
  if (!runtimeContext) return
  const { poolInstance, logger, observerFactory } = runtimeContext
  const role = config.emailRuntimeRole
  const apiRuntimeEnabled = role === 'combined' || role === 'api'
  const workerRuntimeEnabled = role === 'combined' || role === 'worker'
  const mailRuntimes = await managedMailRuntimeConfigs(config)
  const primaryRuntime = mailRuntimes.find((item) => item.emailPrimaryAccount !== false) || mailRuntimes[0] || config
  const ingestRuntimes = mailRuntimes.filter((item) => item.emailIngestEnabled)
  const starters = []
  if (apiRuntimeEnabled) mailRuntimes.forEach((mailRuntime) => starters.push(() => startMailDeliveryScheduler({
    enabled: mailRuntime.mailDeliveryEnabled,
    policy: {
      intervalSeconds: config.mailDeliveryIntervalSeconds,
      batchSize: config.mailDeliveryBatchSize,
      maxAttempts: config.mailDeliveryMaxAttempts
    },
    poolInstance,
    runtimeConfig: mailRuntime,
    logger,
    observer: observerFactory(MAINTENANCE_JOB_NAMES.MAIL_DELIVERY, '邮件发送队列')
  })))
  if (workerRuntimeEnabled) ingestRuntimes.forEach((mailRuntime) => starters.push(() => startEmailIngestWorker({
    enabled: config.emailIngestEnabled || mailRuntime.emailIngestEnabled,
    policy: {
      pollIntervalSeconds: config.imapPollIntervalSeconds,
      initialLookback: config.imapInitialLookback,
      batchSize: config.imapBatchSize,
      maxMessageBytes: config.imapMaxMessageBytes,
      drainMaxBatches: config.imapDrainMaxBatches,
      drainMaxMilliseconds: config.imapDrainMaxMilliseconds,
      protocolReconciliationEnabled: config.imapProtocolReconciliationEnabled,
      secondaryFolderSyncEnabled: config.imapSecondaryFolderSyncEnabled,
      folderSyncIntervalSeconds: config.imapFolderSyncIntervalSeconds,
      foldersPerRun: config.imapFoldersPerRun,
      maxReconcileMessages: config.imapReconcileMaxMessages,
      reconcileBatchSize: config.imapReconcileBatchSize,
      telemetrySampleSize: config.imapTelemetrySampleSize
    },
    poolInstance,
    runtimeConfig: mailRuntime,
    logger,
    observer: observerFactory(MAINTENANCE_JOB_NAMES.EMAIL_INGEST, '邮件接收')
  })))
  if (workerRuntimeEnabled) starters.push(() => startEmailClassificationScheduler({
    enabled: ingestRuntimes.length > 0,
    policy: {
      intervalSeconds: config.emailClassificationIntervalSeconds,
      batchSize: config.emailClassificationBatchSize,
      maxAttempts: config.emailClassificationMaxAttempts,
      staleRunningSeconds: 300
    },
    poolInstance,
    runtimeConfig: {
      ...primaryRuntime,
      emailSourceKeys: ingestRuntimes.map((item) => item.emailSourceKey)
    },
    logger,
    observer: observerFactory(
      MAINTENANCE_JOB_NAMES.EMAIL_CLASSIFICATION,
      '邮件 AI 分类与通知'
    )
  }))
  if (workerRuntimeEnabled) mailRuntimes.forEach((mailRuntime) => starters.push(() => startEmailSentAppendScheduler({
    enabled: mailRuntime.emailSentAppendEnabled,
    policy: {
      intervalSeconds: config.emailSentAppendIntervalSeconds,
      batchSize: config.emailSentAppendBatchSize,
      retentionDays: config.emailSentAppendRetentionDays
    },
    poolInstance,
    runtimeConfig: mailRuntime,
    logger,
    observer: observerFactory(
      MAINTENANCE_JOB_NAMES.EMAIL_SENT_APPEND,
      '已发送邮件同步'
    )
  })))
  if (workerRuntimeEnabled) ingestRuntimes.forEach((mailRuntime) => starters.push(() => startEmailRemoteCommandScheduler({
    enabled: true,
    policy: {
      intervalSeconds: 3,
      batchSize: 10,
      staleRunningSeconds: 300
    },
    poolInstance,
    runtimeConfig: mailRuntime,
    logger,
    observer: observerFactory(
      MAINTENANCE_JOB_NAMES.EMAIL_REMOTE_COMMANDS,
      '邮箱远端操作队列'
    )
  })))
  if (workerRuntimeEnabled) starters.push(() => startEmailCacheRetention({
    enabled: config.emailCacheRetentionEnabled,
    policy: {
      retentionDays: config.emailCacheRetentionDays,
      maxMessagesPerAccount: config.emailCacheMaxMessagesPerAccount,
      batchSize: config.emailCacheRetentionBatchSize,
      maxDeletesPerRun: config.emailCacheRetentionMaxDeletesPerRun,
      outboxRetentionDays: config.emailOutboxRetentionDays,
      intervalSeconds: config.emailCacheRetentionIntervalSeconds
    },
    poolInstance,
    logger,
    observer: observerFactory(
      MAINTENANCE_JOB_NAMES.EMAIL_CACHE_RETENTION,
      '邮箱本地缓存清理'
    )
  }))
  if (apiRuntimeEnabled) starters.push(() => startEmailDigestScheduler({
    enabled: primaryRuntime.emailDigestEnabled,
    policy: {
      intervalSeconds: config.emailDigestIntervalSeconds,
      hours: primaryRuntime.emailDigestHours,
      timeZone: primaryRuntime.emailDigestTimeZone,
      batchSize: config.mailDeliveryBatchSize
    },
    poolInstance,
    runtimeConfig: primaryRuntime,
    logger,
    observer: observerFactory(MAINTENANCE_JOB_NAMES.EMAIL_DIGEST, '邮件摘要生成')
  }))
  stopFunctions = await startRuntimeFunctions(starters)
}

export function configureEmailRuntime(context) {
  runtimeContext = context
  return refreshEmailRuntime()
}

export function refreshEmailRuntime() {
  return reconfigureQueue.run(async () => {
    await stopCurrent()
    await startCurrent()
  })
}

export async function stopEmailRuntime() {
  await reconfigureQueue.wait()
  await stopCurrent()
  runtimeContext = null
}
