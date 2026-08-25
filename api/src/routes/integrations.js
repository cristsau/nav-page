import { config } from '../config.js'
import { refreshEmailRuntime } from '../lib/emailRuntimeController.js'
import { verifyImapConnection } from '../lib/emailIngestScheduler.js'
import { clearEmailEncryptionKeyCache } from '../lib/emailCrypto.js'
import { verifySmtpConnection } from '../lib/mailOutbox.js'
import {
  getManagedIntegrationsState,
  managedCloudTestConfig,
  markManagedCloudVerified,
  markManagedMailVerified,
  saveManagedCloudBackupConfig,
  saveManagedMailConfig,
  withManagedIntegrationMutation
} from '../lib/managedIntegrations.js'
import { recordSecurityEventBestEffort } from '../lib/securityEvents.js'
import { verifyS3Connection } from '../lib/s3ConnectionTest.js'

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
    /格式无效|不能指向|无法解析|必须使用|尚未启用|请先保存|不完整|未配置/.test(message)
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
        const saved = await saveManagedMailConfig(request.body || {})
        clearEmailEncryptionKeyCache()
        await refreshEmailRuntime()
        return saved
      })
      await audit(request, 'admin.integrations.mail.updated', 'mail_integration')
      return { mail, applied: true }
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
