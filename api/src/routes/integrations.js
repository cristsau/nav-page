import { config } from '../config.js'
import {
  MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING,
  refreshEmailRuntime
} from '../lib/emailRuntimeController.js'
import { verifyImapConnection } from '../lib/emailIngestScheduler.js'
import { clearEmailEncryptionKeyCache } from '../lib/emailCrypto.js'
import { verifySmtpConnection } from '../lib/mailOutbox.js'
import {
  createManagedMailAccount,
  getManagedIntegrationsState,
  managedCloudTestConfig,
  managedMailAccountTestConfig,
  markManagedCloudVerified,
  markManagedMailAccountVerified,
  markManagedMailVerified,
  saveManagedMailAccount,
  saveManagedCloudBackupConfig,
  saveManagedMailConfig,
  withManagedIntegrationMutation
} from '../lib/managedIntegrations.js'
import { recordSecurityEventBestEffort } from '../lib/securityEvents.js'
import { verifyS3Connection } from '../lib/s3ConnectionTest.js'
import {
  assertManagedMailOwnerExists,
  MANAGED_MAIL_MATERIALIZATION_WARNING
} from '../lib/managedMailAccountMaterialization.js'

const MANAGED_MAIL_RUNTIME_APPLY_WARNING = '邮箱配置已保存，但运行时应用仍待处理；请稍后重新保存重试。'

export async function applySavedMailRuntime(request, { refreshFn = refreshEmailRuntime } = {}) {
  try {
    const prepared = await refreshFn()
    return {
      saved: true,
      materialized: prepared?.reconciliation?.pending === 0,
      applied: true
    }
  } catch (error) {
    const materialization = error?.materialization
    const materialized = materialization ? materialization.pending === 0 : false
    const warning = error?.code === MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING
      ? MANAGED_MAIL_MATERIALIZATION_WARNING
      : MANAGED_MAIL_RUNTIME_APPLY_WARNING
    request.log?.warn?.({
      errorCode: String(error?.code || 'EMAIL_RUNTIME_APPLY_FAILED'),
      materialized
    }, 'Managed mailbox configuration was saved but runtime apply is pending')
    return { saved: true, materialized, applied: false, warning }
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
      const { mail, runtimeStatus } = await withManagedIntegrationMutation(async () => {
        await assertManagedMailOwnerExists(
          request.body?.ownerUsername ?? config.emailOwnerUsername
        )
        const saved = await saveManagedMailConfig(request.body || {})
        clearEmailEncryptionKeyCache()
        return { mail: saved, runtimeStatus: await applySavedMailRuntime(request) }
      })
      await audit(request, 'admin.integrations.mail.updated', 'mail_integration')
      return { mail, ...runtimeStatus }
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
      const { account, runtimeStatus } = await withManagedIntegrationMutation(async () => {
        await assertManagedMailOwnerExists(
          request.body?.ownerUsername ?? config.emailOwnerUsername
        )
        const saved = await createManagedMailAccount(request.body || {})
        clearEmailEncryptionKeyCache()
        return { account: saved, runtimeStatus: await applySavedMailRuntime(request) }
      })
      await audit(request, 'admin.integrations.mail_account.created', 'mail_integration')
      reply.code(201)
      return { account, ...runtimeStatus }
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
      const { account, runtimeStatus } = await withManagedIntegrationMutation(async () => {
        const saved = await saveManagedMailAccount(request.params?.accountId, request.body || {})
        clearEmailEncryptionKeyCache()
        return { account: saved, runtimeStatus: await applySavedMailRuntime(request) }
      })
      await audit(request, 'admin.integrations.mail_account.updated', 'mail_integration')
      return { account, ...runtimeStatus }
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
