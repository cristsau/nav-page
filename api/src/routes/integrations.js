import { config } from '../config.js'
import {
  assertEmailRuntimeAvailable,
  EMAIL_RUNTIME_FAIL_CLOSED,
  preflightEmailRuntime,
  refreshEmailRuntime,
  suspendEmailRuntime
} from '../lib/emailRuntimeController.js'
import { verifyImapConnection } from '../lib/emailIngestScheduler.js'
import { clearEmailEncryptionKeyCache } from '../lib/emailCrypto.js'
import { verifySmtpConnection } from '../lib/mailOutbox.js'
import {
  applyManagedIntegrationsToRuntime,
  beginManagedMailUpdate,
  completeManagedMailUpdate,
  createManagedMailAccount,
  getManagedIntegrationsState,
  managedCloudTestConfig,
  managedMailAccountTestConfig,
  managedMailRuntimeConfigs,
  MANAGED_MAIL_UPDATE_IN_PROGRESS,
  markManagedCloudVerified,
  markManagedMailAccountVerified,
  markManagedMailVerified,
  restoreManagedMailPersistence,
  restoreManagedMailRuntimeConfig,
  saveManagedMailAccount,
  saveManagedCloudBackupConfig,
  saveManagedMailConfig,
  snapshotManagedMailPersistence,
  snapshotManagedMailRuntimeConfig,
  withManagedIntegrationMutation
} from '../lib/managedIntegrations.js'
import { recordSecurityEventBestEffort } from '../lib/securityEvents.js'
import { verifyS3Connection } from '../lib/s3ConnectionTest.js'
import {
  assertManagedMailOwnerExists,
  restoreManagedMailAccountRows,
  snapshotManagedMailAccountRows
} from '../lib/managedMailAccountMaterialization.js'

export const MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED = 'MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED'
export const MANAGED_MAIL_WORKER_PENDING_WARNING = '邮箱配置已保存并应用到当前 API；独立邮件 Worker 将在下一次配置刷新时应用。'

function successfulManagedMailRuntimeStatus() {
  return {
    saved: true,
    materialized: true,
    applied: true,
    workerApplied: 'pending',
    warning: MANAGED_MAIL_WORKER_PENDING_WARNING
  }
}

function safeTransactionErrorCode(error, fallback) {
  const code = String(error?.code || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback
}

export async function runManagedMailSaveTransaction(request, {
  saveFn,
  runtimeConfig = config,
  snapshotPersistenceFn = snapshotManagedMailPersistence,
  restorePersistenceFn = restoreManagedMailPersistence,
  snapshotRuntimeFn = snapshotManagedMailRuntimeConfig,
  restoreRuntimeFn = restoreManagedMailRuntimeConfig,
  assertRuntimeAvailableFn = assertEmailRuntimeAvailable,
  loadRuntimeConfigsFn = managedMailRuntimeConfigs,
  snapshotAccountRowsFn = snapshotManagedMailAccountRows,
  restoreAccountRowsFn = restoreManagedMailAccountRows,
  beginUpdateFn = beginManagedMailUpdate,
  completeUpdateFn = completeManagedMailUpdate,
  preflightFn = preflightEmailRuntime,
  applyRuntimeFn = applyManagedIntegrationsToRuntime,
  refreshFn = refreshEmailRuntime,
  clearCacheFn = clearEmailEncryptionKeyCache,
  suspendRuntimeFn = suspendEmailRuntime
} = {}) {
  if (typeof saveFn !== 'function') throw new TypeError('邮件配置保存操作无效')
  assertRuntimeAvailableFn()
  const update = await beginUpdateFn(runtimeConfig)
  const updateToken = update.token
  let persistenceSnapshot = null
  let runtimeSnapshot = null
  let accountRowsSnapshot = null
  try {
    persistenceSnapshot = await snapshotPersistenceFn(runtimeConfig)
    runtimeSnapshot = snapshotRuntimeFn(runtimeConfig)
    const value = await saveFn({ updateToken })
    const mailRuntimes = await loadRuntimeConfigsFn(runtimeConfig, { updateToken })
    accountRowsSnapshot = await snapshotAccountRowsFn(mailRuntimes)
    await clearCacheFn()
    await preflightFn({ runtimeConfig, updateToken })
    await applyRuntimeFn(runtimeConfig, { updateToken })
    await refreshFn({ updateToken })
    await completeUpdateFn(update, runtimeConfig)
    return value
  } catch (originalError) {
    const rollbackFailures = []
    if (persistenceSnapshot) {
      try {
        await restorePersistenceFn(persistenceSnapshot, runtimeConfig)
      } catch (error) {
        rollbackFailures.push(error)
      }
    }
    if (accountRowsSnapshot) {
      try {
        await restoreAccountRowsFn(accountRowsSnapshot)
      } catch (error) {
        rollbackFailures.push(error)
      }
    }
    if (runtimeSnapshot) {
      try {
        restoreRuntimeFn(runtimeSnapshot, runtimeConfig)
      } catch (error) {
        rollbackFailures.push(error)
      }
    }
    try {
      await clearCacheFn()
    } catch (error) {
      rollbackFailures.push(error)
    }
    if (rollbackFailures.length === 0 && persistenceSnapshot && runtimeSnapshot) {
      try {
        await refreshFn({ updateToken })
      } catch (error) {
        rollbackFailures.push(error)
      }
    }
    if (rollbackFailures.length === 0) {
      try {
        await completeUpdateFn(update, runtimeConfig)
      } catch (error) {
        rollbackFailures.push(error)
      }
    }
    if (rollbackFailures.length > 0) {
      let suspensionError = null
      let suspensionConfirmed = false
      try {
        const result = await suspendRuntimeFn({ reason: MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED })
        suspensionConfirmed = result?.suspended === true
      } catch (error) {
        suspensionError = error
      }
      const error = new Error(suspensionConfirmed
        ? '邮件配置回滚未完成；邮件运行时已暂停，请核对配置后重启邮件服务'
        : '邮件配置回滚未完成且运行时暂停未确认；当前运行状态未知，请立即重启邮件服务')
      error.code = MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED
      error.suspensionConfirmed = suspensionConfirmed
      error.originalErrorCode = safeTransactionErrorCode(
        originalError,
        'MAIL_INTEGRATION_TRANSACTION_FAILED'
      )
      error.rollbackErrorCode = safeTransactionErrorCode(
        rollbackFailures[0],
        'MAIL_INTEGRATION_ROLLBACK_FAILED'
      )
      error.suspensionErrorCode = suspensionError
        ? safeTransactionErrorCode(suspensionError, 'MAIL_RUNTIME_SUSPEND_FAILED')
        : null
      request.log?.error?.({
        errorCode: error.code,
        originalErrorCode: error.originalErrorCode,
        rollbackErrorCode: error.rollbackErrorCode,
        suspensionConfirmed: error.suspensionConfirmed,
        suspensionErrorCode: error.suspensionErrorCode
      }, suspensionConfirmed
        ? 'Managed mailbox save rollback failed; runtime was suspended'
        : 'Managed mailbox save rollback failed; runtime suspension is unconfirmed')
      throw error
    }
    request.log?.warn?.({
      errorCode: safeTransactionErrorCode(
        originalError,
        'MAIL_INTEGRATION_TRANSACTION_FAILED'
      )
    }, 'Managed mailbox save failed and the previous configuration was restored')
    throw originalError
  }
}

async function audit(request, eventType, resourceType, outcome = 'success') {
  await recordSecurityEventBestEffort({
    request,
    eventType,
    outcome,
    actorUserId: request.currentUser.id,
    subjectUserId: request.currentUser.id,
    resourceType,
    resourceId: null,
    affectedCount: 1
  }, request.log)
}

export function safeConnectionError(error, fallback) {
  const message = String(error?.message || '')
  if (error?.code === MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED) {
    return message.slice(0, 240)
  }
  if (error?.code === EMAIL_RUNTIME_FAIL_CLOSED) {
    return '邮件运行时已因上次配置回滚失败而暂停，请核对配置后重启邮件服务'
  }
  if (error?.code === MANAGED_MAIL_UPDATE_IN_PROGRESS) {
    return '邮件配置更新仍在进行或需要人工恢复，请先核对服务状态'
  }
  if (
    /格式无效|不能指向|无法解析|必须使用|尚未启用|请先保存|不完整|未配置|不存在|最多支持/.test(message)
    || message === '启用云备份前，请完整填写对象存储配置并通过只读连接测试'
  ) {
    return message.slice(0, 240)
  }
  return fallback
}

export default async function integrationRoutes(fastify) {
  fastify.get('/admin/integrations', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    return getManagedIntegrationsState()
  })

  fastify.put('/admin/integrations/mail', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const mail = await withManagedIntegrationMutation(async () => {
        await assertManagedMailOwnerExists(
          request.body?.ownerUsername ?? config.emailOwnerUsername
        )
        return runManagedMailSaveTransaction(request, {
          saveFn: ({ updateToken }) => saveManagedMailConfig(
            request.body || {},
            config,
            { updateToken }
          )
        })
      })
      await audit(request, 'admin.integrations.mail.updated', 'mail_integration')
      return { mail, ...successfulManagedMailRuntimeStatus() }
    } catch (error) {
      await audit(request, 'admin.integrations.mail.updated', 'mail_integration', 'denied')
      reply.code(error instanceof TypeError ? 400 : 503)
      return { error: safeConnectionError(error, '邮件配置保存失败，请检查服务器的可管理集成目录') }
    }
  })

  fastify.post('/admin/integrations/mail/test-smtp', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { result, mail } = await withManagedIntegrationMutation(async () => ({
        result: await verifySmtpConnection(config),
        mail: await markManagedMailVerified('smtp')
      }))
      await audit(request, 'admin.integrations.mail.smtp_tested', 'mail_integration')
      return { result, mail }
    } catch (error) {
      await audit(request, 'admin.integrations.mail.smtp_tested', 'mail_integration', 'failure')
      reply.code(502)
      return { error: safeConnectionError(error, 'SMTP 连接测试失败，请核对主机名、邮箱账号、密码和 TLS 端口') }
    }
  })

  fastify.post('/admin/integrations/mail/test-imap', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { result, mail } = await withManagedIntegrationMutation(async () => ({
        result: await verifyImapConnection(config),
        mail: await markManagedMailVerified('imap')
      }))
      await audit(request, 'admin.integrations.mail.imap_tested', 'mail_integration')
      return { result, mail }
    } catch (error) {
      await audit(request, 'admin.integrations.mail.imap_tested', 'mail_integration', 'failure')
      reply.code(502)
      return { error: safeConnectionError(error, 'IMAP 连接测试失败，请核对主机名、邮箱账号、密码和 TLS 端口') }
    }
  })

  fastify.post('/admin/integrations/mail/accounts', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const account = await withManagedIntegrationMutation(async () => {
        await assertManagedMailOwnerExists(
          request.body?.ownerUsername ?? config.emailOwnerUsername
        )
        return runManagedMailSaveTransaction(request, {
          saveFn: ({ updateToken }) => createManagedMailAccount(
            request.body || {},
            config,
            { updateToken }
          )
        })
      })
      await audit(request, 'admin.integrations.mail_account.created', 'mail_integration')
      reply.code(201)
      return { account, ...successfulManagedMailRuntimeStatus() }
    } catch (error) {
      await audit(request, 'admin.integrations.mail_account.created', 'mail_integration', 'denied')
      reply.code(error instanceof TypeError ? 400 : 503)
      return { error: safeConnectionError(error, '邮箱账号创建失败，请检查服务器的可管理集成目录') }
    }
  })

  fastify.put('/admin/integrations/mail/accounts/:accountId', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const account = await withManagedIntegrationMutation(async () => {
        return runManagedMailSaveTransaction(request, {
          saveFn: ({ updateToken }) => saveManagedMailAccount(
            request.params?.accountId,
            request.body || {},
            config,
            { updateToken }
          )
        })
      })
      await audit(request, 'admin.integrations.mail_account.updated', 'mail_integration')
      return { account, ...successfulManagedMailRuntimeStatus() }
    } catch (error) {
      await audit(request, 'admin.integrations.mail_account.updated', 'mail_integration', 'denied')
      reply.code(error instanceof TypeError ? 400 : 503)
      return { error: safeConnectionError(error, '邮箱账号保存失败，请检查服务器的可管理集成目录') }
    }
  })

  fastify.post('/admin/integrations/mail/accounts/:accountId/test-smtp', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { result, account } = await withManagedIntegrationMutation(async () => {
        const testConfig = await managedMailAccountTestConfig(request.params?.accountId)
        return {
          result: await verifySmtpConnection(testConfig),
          account: await markManagedMailAccountVerified('smtp', request.params?.accountId)
        }
      })
      await audit(request, 'admin.integrations.mail_account.smtp_tested', 'mail_integration')
      return { result, account }
    } catch (error) {
      await audit(request, 'admin.integrations.mail_account.smtp_tested', 'mail_integration', 'failure')
      reply.code(502)
      return { error: safeConnectionError(error, 'SMTP 连接测试失败，请核对主机名、邮箱账号、密码和 TLS 端口') }
    }
  })

  fastify.post('/admin/integrations/mail/accounts/:accountId/test-imap', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { result, account } = await withManagedIntegrationMutation(async () => {
        const testConfig = await managedMailAccountTestConfig(request.params?.accountId)
        return {
          result: await verifyImapConnection(testConfig),
          account: await markManagedMailAccountVerified('imap', request.params?.accountId)
        }
      })
      await audit(request, 'admin.integrations.mail_account.imap_tested', 'mail_integration')
      return { result, account }
    } catch (error) {
      await audit(request, 'admin.integrations.mail_account.imap_tested', 'mail_integration', 'failure')
      reply.code(502)
      return { error: safeConnectionError(error, 'IMAP 连接测试失败，请核对主机名、邮箱账号、密码和 TLS 端口') }
    }
  })

  fastify.put('/admin/integrations/cloud-backup', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const cloudBackup = await withManagedIntegrationMutation(
        () => saveManagedCloudBackupConfig(request.body || {})
      )
      await audit(request, 'admin.integrations.cloud_backup.updated', 'cloud_backup_integration')
      return { cloudBackup }
    } catch (error) {
      await audit(request, 'admin.integrations.cloud_backup.updated', 'cloud_backup_integration', 'denied')
      reply.code(error instanceof TypeError ? 400 : 503)
      return { error: safeConnectionError(error, '云备份配置保存失败，请检查服务器的可管理集成目录') }
    }
  })

  fastify.post('/admin/integrations/cloud-backup/test', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const { result, cloudBackup } = await withManagedIntegrationMutation(async () => {
        const testConfig = await managedCloudTestConfig()
        return {
          result: await verifyS3Connection(testConfig),
          cloudBackup: await markManagedCloudVerified()
        }
      })
      await audit(request, 'admin.integrations.cloud_backup.tested', 'cloud_backup_integration')
      return { result, cloudBackup }
    } catch (error) {
      await audit(request, 'admin.integrations.cloud_backup.tested', 'cloud_backup_integration', 'failure')
      reply.code(502)
      return { error: safeConnectionError(error, '对象存储连接测试失败，请核对 Endpoint、Bucket、Region 和访问密钥') }
    }
  })
}
