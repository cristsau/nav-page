import { config } from '../config.js'
import { startEmailDigestScheduler } from './emailDigestScheduler.js'
import { startEmailIngestScheduler } from './emailIngestScheduler.js'
import { MAINTENANCE_JOB_NAMES } from './maintenanceJobStatus.js'
import { startMailDeliveryScheduler } from './mailOutbox.js'

let runtimeContext = null
let stopFunctions = []
let reconfigureQueue = Promise.resolve()

async function stopCurrent() {
  const current = stopFunctions
  stopFunctions = []
  await Promise.all(current.map((stop) => Promise.resolve().then(() => stop())))
}

async function startCurrent() {
  if (!runtimeContext) return
  const { poolInstance, logger, observerFactory } = runtimeContext
  stopFunctions = [
    startMailDeliveryScheduler({
      enabled: config.mailDeliveryEnabled,
      policy: {
        intervalSeconds: config.mailDeliveryIntervalSeconds,
        batchSize: config.mailDeliveryBatchSize,
        maxAttempts: config.mailDeliveryMaxAttempts
      },
      poolInstance,
      logger,
      observer: observerFactory(MAINTENANCE_JOB_NAMES.MAIL_DELIVERY, '邮件发送队列')
    }),
    startEmailIngestScheduler({
      enabled: config.emailIngestEnabled,
      policy: {
        pollIntervalSeconds: config.imapPollIntervalSeconds,
        initialLookback: config.imapInitialLookback,
        batchSize: config.imapBatchSize,
        maxMessageBytes: config.imapMaxMessageBytes
      },
      poolInstance,
      logger,
      observer: observerFactory(MAINTENANCE_JOB_NAMES.EMAIL_INGEST, 'MXroute 邮件接收与分类')
    }),
    startEmailDigestScheduler({
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
    })
  ]
}

export function configureEmailRuntime(context) {
  runtimeContext = context
  return refreshEmailRuntime()
}

export function refreshEmailRuntime() {
  reconfigureQueue = reconfigureQueue.then(async () => {
    await stopCurrent()
    await startCurrent()
  })
  return reconfigureQueue
}

export async function stopEmailRuntime() {
  await reconfigureQueue
  await stopCurrent()
  runtimeContext = null
}
