import { config } from '../config.js'
import { startEmailCacheRetention } from './emailRetention.js'
import { startEmailDigestScheduler } from './emailDigestScheduler.js'
import { startEmailIngestWorker } from './emailIngestWorker.js'
import { MAINTENANCE_JOB_NAMES } from './maintenanceJobStatus.js'
import { startMailDeliveryScheduler } from './mailOutbox.js'
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
  const starters = []
  if (apiRuntimeEnabled) starters.push(() => startMailDeliveryScheduler({
    enabled: config.mailDeliveryEnabled,
    policy: {
      intervalSeconds: config.mailDeliveryIntervalSeconds,
      batchSize: config.mailDeliveryBatchSize,
      maxAttempts: config.mailDeliveryMaxAttempts
    },
    poolInstance,
    logger,
    observer: observerFactory(MAINTENANCE_JOB_NAMES.MAIL_DELIVERY, '邮件发送队列')
  }))
  if (workerRuntimeEnabled) starters.push(() => startEmailIngestWorker({
    enabled: config.emailIngestEnabled,
    policy: {
      pollIntervalSeconds: config.imapPollIntervalSeconds,
      initialLookback: config.imapInitialLookback,
      batchSize: config.imapBatchSize,
      maxMessageBytes: config.imapMaxMessageBytes
    },
    poolInstance,
    logger,
    observer: observerFactory(MAINTENANCE_JOB_NAMES.EMAIL_INGEST, '邮件接收与分类')
  }))
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
    enabled: config.emailDigestEnabled,
    policy: {
      intervalSeconds: config.emailDigestIntervalSeconds,
      hours: config.emailDigestHours,
      timeZone: config.emailDigestTimeZone,
      batchSize: config.mailDeliveryBatchSize
    },
    poolInstance,
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
