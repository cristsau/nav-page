import { assertSafeMailWorkerDatabasePoolSize, config } from '../config.js'
import { startEmailCacheRetention } from './emailRetention.js'
import { startEmailDigestScheduler } from './emailDigestScheduler.js'
import { startEmailIngestWorker } from './emailIngestWorker.js'
import { startEmailClassificationScheduler } from './emailClassificationWorker.js'
import { startEmailSentAppendScheduler } from './emailSentAppend.js'
import { startEmailRemoteCommandScheduler } from './emailRemoteCommandWorker.js'
import { MAINTENANCE_JOB_NAMES } from './maintenanceJobStatus.js'
import { startMailDeliveryScheduler } from './mailOutbox.js'
import { managedMailRuntimeConfigs } from './managedIntegrations.js'
import { reconcileManagedMailRuntimeAccounts } from './managedMailAccountMaterialization.js'
import { createSourceAwareMaintenanceObserverGroup } from './sourceAwareMaintenanceObserver.js'
import {
  createRecoverableSerialQueue,
  startRuntimeFunctions,
  stopRuntimeFunctions
} from './runtimeLifecycle.js'

let runtimeContext = null
let stopFunctions = []
const reconfigureQueue = createRecoverableSerialQueue()

export const MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING = 'MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING'

async function stopCurrent() {
  const current = stopFunctions
  stopFunctions = []
  await stopRuntimeFunctions(current)
}

export async function preflightEmailRuntime({
  runtimeConfig = config,
  loadRuntimes = managedMailRuntimeConfigs,
  reconcileFn = reconcileManagedMailRuntimeAccounts
} = {}) {
  const mailRuntimes = await loadRuntimes(runtimeConfig)
  const reconciliation = await reconcileFn(mailRuntimes)
  if (reconciliation.pending > 0) {
    const error = new Error('Managed mailbox database registration is pending')
    error.code = MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING
    error.materialization = reconciliation
    throw error
  }
  const role = runtimeConfig.emailRuntimeRole
  const workerRuntimeEnabled = role === 'combined' || role === 'worker'
  if (workerRuntimeEnabled) {
    try {
      assertSafeMailWorkerDatabasePoolSize(
        runtimeConfig.databasePoolMax,
        mailRuntimes.filter((item) => item.emailIngestEnabled).length
      )
    } catch (error) {
      error.materialization = reconciliation
      throw error
    }
  }
  return { mailRuntimes, reconciliation }
}

export async function replaceEmailRuntime({ preflight, stop, start }) {
  const prepared = await preflight()
  await stop()
  await start(prepared)
  return prepared
}

async function startCurrent(prepared) {
  if (!runtimeContext) return
  const { poolInstance, logger, observerFactory } = runtimeContext
  const role = config.emailRuntimeRole
  const apiRuntimeEnabled = role === 'combined' || role === 'api'
  const workerRuntimeEnabled = role === 'combined' || role === 'worker'
  const mailRuntimes = prepared?.mailRuntimes || []
  const primaryRuntime = mailRuntimes.find((item) => item.emailPrimaryAccount !== false) || mailRuntimes[0] || config
  const ingestRuntimes = mailRuntimes.filter((item) => item.emailIngestEnabled)
  const deliveryRuntimes = mailRuntimes.filter((item) => item.mailDeliveryEnabled)
  const sentAppendRuntimes = mailRuntimes.filter((item) => item.emailSentAppendEnabled)
  const starters = []
  const observerGroup = (jobName, jobLabel, runtimes) => {
    const sourceKeys = runtimes.map((mailRuntime) => (
      String(mailRuntime.emailSourceKey || config.emailSourceKey || 'mxroute')
    ))
    const group = createSourceAwareMaintenanceObserverGroup(
      observerFactory(jobName, jobLabel),
      { sourceKeys }
    )
    return (mailRuntime) => group.forSource(
      String(mailRuntime.emailSourceKey || config.emailSourceKey || 'mxroute')
    )
  }
  const deliveryObserver = observerGroup(MAINTENANCE_JOB_NAMES.MAIL_DELIVERY, '邮件发送队列', deliveryRuntimes)
  const ingestObserver = observerGroup(MAINTENANCE_JOB_NAMES.EMAIL_INGEST, '邮件接收', ingestRuntimes)
  const sentAppendObserver = observerGroup(MAINTENANCE_JOB_NAMES.EMAIL_SENT_APPEND, '已发送邮件同步', sentAppendRuntimes)
  const remoteCommandObserver = observerGroup(MAINTENANCE_JOB_NAMES.EMAIL_REMOTE_COMMANDS, '邮箱远端操作队列', ingestRuntimes)
  if (apiRuntimeEnabled) deliveryRuntimes.forEach((mailRuntime) => starters.push(() => startMailDeliveryScheduler({
    enabled: mailRuntime.mailDeliveryEnabled,
    policy: {
      intervalSeconds: config.mailDeliveryIntervalSeconds,
      batchSize: config.mailDeliveryBatchSize,
      maxAttempts: config.mailDeliveryMaxAttempts
    },
    poolInstance,
    runtimeConfig: mailRuntime,
    logger,
    observer: deliveryObserver(mailRuntime)
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
    observer: ingestObserver(mailRuntime)
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
  if (workerRuntimeEnabled) sentAppendRuntimes.forEach((mailRuntime) => starters.push(() => startEmailSentAppendScheduler({
    enabled: mailRuntime.emailSentAppendEnabled,
    policy: {
      intervalSeconds: config.emailSentAppendIntervalSeconds,
      batchSize: config.emailSentAppendBatchSize,
      retentionDays: config.emailSentAppendRetentionDays
    },
    poolInstance,
    runtimeConfig: mailRuntime,
    logger,
    observer: sentAppendObserver(mailRuntime)
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
    observer: remoteCommandObserver(mailRuntime)
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
  return reconfigureQueue.run(() => replaceEmailRuntime({
    preflight: () => preflightEmailRuntime(),
    stop: stopCurrent,
    start: startCurrent
  }))
}

export async function stopEmailRuntime() {
  await reconfigureQueue.wait()
  await stopCurrent()
  runtimeContext = null
}
