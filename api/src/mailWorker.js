import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertSafeMailWorkerDatabasePoolSize,
  config
} from './config.js'
import { pool } from './db/index.js'
import { clearEmailEncryptionKeyCache } from './lib/emailCrypto.js'
import { configureEmailRuntime, refreshEmailRuntime, stopEmailRuntime } from './lib/emailRuntimeController.js'
import { applyManagedIntegrationsToRuntime } from './lib/managedIntegrations.js'
import { applyManagedOauthToRuntime } from './lib/managedOauthIntegrations.js'
import {
  createMaintenanceJobObserver,
  MAINTENANCE_JOB_NAMES
} from './lib/maintenanceJobStatus.js'
import { configureOutboundNetwork } from './lib/network.js'
import { sendMaintenanceNotification } from './lib/notificationDelivery.js'

const CONFIG_REFRESH_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 15_000
const heartbeatPath = path.resolve(
  process.env.NAV_MAIL_WORKER_HEARTBEAT_FILE
    || path.join(os.tmpdir(), 'nav-mail-worker-heartbeat.json')
)

function createWorkerLogger() {
  const write = (level, context, message) => {
    const payload = context && typeof context === 'object' && !Array.isArray(context) ? context : {}
    const text = typeof context === 'string' && message === undefined ? context : message
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      service: 'nav-mail-worker',
      message: String(text || ''),
      ...payload
    })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    info: (context, message) => write('info', context, message),
    warn: (context, message) => write('warn', context, message),
    error: (context, message) => write('error', context, message)
  }
}

async function writeHeartbeat() {
  const temporary = `${heartbeatPath}.${process.pid}.tmp`
  const payload = `${JSON.stringify({
    pid: process.pid,
    releaseSha: String(process.env.NAV_RELEASE_SHA || 'development'),
    updatedAt: new Date().toISOString()
  })}\n`
  await fs.mkdir(path.dirname(heartbeatPath), { recursive: true })
  await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, heartbeatPath)
}

function integrationRevision(applied) {
  return `${String(applied?.source || 'environment')}:${String(applied?.document?.updatedAt || '')}`
}

configureOutboundNetwork()

async function main() {
  if (config.emailRuntimeRole !== 'worker') {
    throw new Error('nav-mail-worker requires NAV_EMAIL_RUNTIME_ROLE=worker')
  }
  assertSafeMailWorkerDatabasePoolSize(config.databasePoolMax)
  const logger = createWorkerLogger()
  const initialIntegration = await applyManagedIntegrationsToRuntime()
  const initialOauthIntegration = await applyManagedOauthToRuntime()
  let currentRevision = `${integrationRevision(initialIntegration)}:${integrationRevision(initialOauthIntegration)}`
  // The API container owns migrations. Its healthy dependency guarantees the
  // migration runner finished; resolve every mailbox table here as a final
  // contract check before this process can acquire an ingest lease.
  await pool.query(`
    SELECT 1
    FROM email_accounts, email_folders, email_messages, email_folder_messages,
         email_sent_append_jobs
    LIMIT 0
  `)

  const observerOptions = {
    poolInstance: pool,
    logger,
    alertsEnabled: config.maintenanceAlertsEnabled,
    failureThreshold: config.maintenanceAlertFailureThreshold,
    alertCooldownSeconds: config.maintenanceAlertCooldownSeconds,
    notifyFn: sendMaintenanceNotification
  }
  await configureEmailRuntime({
    poolInstance: pool,
    logger,
    observerFactory: (jobName, jobLabel) => createMaintenanceJobObserver({
      ...observerOptions,
      jobName,
      jobLabel
    })
  })

  await writeHeartbeat()
  const heartbeatTimer = setInterval(() => {
    void writeHeartbeat().catch((error) => logger.warn({ errorCode: error?.code || 'HEARTBEAT_WRITE_FAILED' }, 'mail worker heartbeat could not be written'))
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()

  let refreshActive = false
  const configTimer = setInterval(() => {
    if (refreshActive) return
    refreshActive = true
    void Promise.all([
      applyManagedIntegrationsToRuntime(),
      applyManagedOauthToRuntime()
    ])
      .then(async ([applied, oauthApplied]) => {
        const nextRevision = `${integrationRevision(applied)}:${integrationRevision(oauthApplied)}`
        if (nextRevision === currentRevision) return
        clearEmailEncryptionKeyCache()
        await refreshEmailRuntime()
        currentRevision = nextRevision
        logger.info({ revision: nextRevision }, 'mail worker configuration refreshed')
      })
      .catch((error) => logger.error({ errorCode: error?.code || 'CONFIG_REFRESH_FAILED' }, 'mail worker configuration refresh failed'))
      .finally(() => { refreshActive = false })
  }, CONFIG_REFRESH_MS)
  configTimer.unref?.()

  let closePromise = null
  const close = (signal) => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      clearInterval(configTimer)
      clearInterval(heartbeatTimer)
      logger.info({ signal }, 'mail worker is stopping')
      await stopEmailRuntime()
      await pool.end()
      await fs.rm(heartbeatPath, { force: true }).catch(() => {})
    })()
    return closePromise
  }
  const closeAndExit = (signal) => {
    void close(signal).then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  process.once('SIGINT', () => closeAndExit('SIGINT'))
  process.once('SIGTERM', () => closeAndExit('SIGTERM'))
  logger.info({
    jobName: MAINTENANCE_JOB_NAMES.EMAIL_INGEST,
    databasePoolMax: config.databasePoolMax,
    releaseSha: String(process.env.NAV_RELEASE_SHA || 'development')
  }, 'mail worker started')
}

main().catch(async (error) => {
  console.error(JSON.stringify({
    level: 'error',
    time: new Date().toISOString(),
    service: 'nav-mail-worker',
    message: 'mail worker failed to start',
    errorCode: error?.code || error?.name || 'MAIL_WORKER_START_FAILED'
  }))
  await pool.end().catch(() => {})
  process.exit(1)
})
