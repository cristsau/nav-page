import { config } from '../config.js'
import { startMailDeliveryScheduler } from './mailOutbox.js'
import { enforceMailboxRetirement } from './mailboxRetirement.js'
import { createRecoverableSerialQueue } from './runtimeLifecycle.js'
import { startAuthEmailDeliveryScheduler } from './authEmailDelivery.js'

const queue = createRecoverableSerialQueue()
let context = null
let stopDelivery = null
let stopAuthDelivery = null

export function refreshSystemMailRuntime() {
  return queue.run(async () => {
    if (stopAuthDelivery) await stopAuthDelivery()
    stopAuthDelivery = null
    if (stopDelivery) await stopDelivery()
    stopDelivery = null
    enforceMailboxRetirement(config)
    if (!context) return
    stopAuthDelivery = startAuthEmailDeliveryScheduler({poolInstance:context.poolInstance,runtimeConfig:{...config},logger:context.logger})
    stopDelivery = startMailDeliveryScheduler({
      enabled: config.mailDeliveryEnabled,
      policy: {
        intervalSeconds: config.mailDeliveryIntervalSeconds,
        batchSize: config.mailDeliveryBatchSize,
        maxAttempts: config.mailDeliveryMaxAttempts
      },
      poolInstance: context.poolInstance,
      runtimeConfig: { ...config, emailPrimaryAccount: true },
      systemOnly: true,
      logger: context.logger,
      observer: context.observerFactory('mail_delivery', '系统通知发送')
    })
  })
}

export function configureSystemMailRuntime(nextContext) {
  context = nextContext
  return refreshSystemMailRuntime()
}

export async function stopSystemMailRuntime() {
  await queue.run(async () => {
    if (stopAuthDelivery) await stopAuthDelivery()
    stopAuthDelivery = null
    if (stopDelivery) await stopDelivery()
    stopDelivery = null
    context = null
  })
}

export async function suspendSystemMailRuntime() {
  await queue.run(async () => {
    if (stopAuthDelivery) await stopAuthDelivery()
    stopAuthDelivery = null
    if (stopDelivery) await stopDelivery()
    stopDelivery = null
  })
}
