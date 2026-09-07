import { config } from '../config.js'
import { randomUUID } from 'node:crypto'
import {
  applyManagedIntegrationsToRuntime, getManagedIntegrationsState,
  managedCloudTestConfig, markManagedCloudVerified, markManagedMailVerified,
  restoreManagedMailPersistence, restoreManagedMailRuntimeConfig,
  saveManagedCloudBackupConfig, saveManagedMailConfig,
  snapshotManagedMailPersistence, snapshotManagedMailRuntimeConfig,
  withManagedIntegrationMutation
} from '../lib/managedIntegrations.js'
import { recordSecurityEventBestEffort } from '../lib/securityEvents.js'
import { verifyS3Connection } from '../lib/s3ConnectionTest.js'
import { verifySmtpConnection, verifiedMailConfigurationStatus, normalizeEmailAddress, enqueueMail } from '../lib/mailOutbox.js'
import { refreshSystemMailRuntime, suspendSystemMailRuntime } from '../lib/systemMailRuntime.js'
import { enforceMailboxRetirement } from '../lib/mailboxRetirement.js'

const SYSTEM_FIELDS = new Set([
  'deliveryEnabled', 'registrationEnabled', 'smtpHost', 'smtpPort', 'smtpUsername',
  'smtpFromAddress', 'smtpFromName', 'adminRecipients', 'smtpPassword'
])

export function normalizeSystemMailInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !SYSTEM_FIELDS.has(key))) {
    throw new TypeError('系统通知配置包含不支持的字段')
  }
  return { ...value, ingestEnabled: false, digestEnabled: false }
}

function systemMailState(mail = {}) {
  return {
    config: Object.fromEntries(Object.entries(mail.config || {}).filter(([key]) => SYSTEM_FIELDS.has(key) && key !== 'smtpPassword')),
    secrets: { smtpPasswordConfigured: mail.secrets?.smtpPasswordConfigured === true },
    verification: {
      smtpVerified: mail.verification?.smtpVerified === true,
      smtpVerifiedAt: mail.verification?.smtpVerifiedAt || null
    }
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

function safeConnectionError(error, fallback) {
  const message = String(error?.message || '')
  return error instanceof TypeError ? message.slice(0, 240) : fallback
}

export default async function systemIntegrationRoutes(fastify) {
  // Transactional system mail remains available; personal mailbox routes do not.
  fastify.get('/admin/mail/status', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    return { mail: await verifiedMailConfigurationStatus(), mailboxRetired: true }
  })

  fastify.post('/admin/mail/test', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const status = await verifiedMailConfigurationStatus()
    if (!status.configured || !status.enabled) {
      return reply.code(503).send({ error: '系统通知通道尚未配置并启用' })
    }
    let recipient
    try { recipient = normalizeEmailAddress(request.body?.recipient) } catch {
      return reply.code(400).send({ error: '请输入有效的测试收件地址' })
    }
    const queued = await enqueueMail({
      messageType: 'system.test', recipient,
      subject: 'DOMO NAV 系统通知通道测试',
      textBody: '这是 DOMO NAV 的系统通知测试。收到此邮件说明注册验证和系统告警所用的 SMTP 通道工作正常。',
      htmlBody: '', sensitive: true,
      dedupeKey: `system-test:${request.currentUser.id}:${randomUUID()}`
    })
    await audit(request, 'admin.mail.test', 'mail_outbox')
    return reply.code(202).send({ queued: true, id: queued.id, status: queued.status })
  })

  fastify.get('/admin/integrations', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const state = await getManagedIntegrationsState()
    return {
      writable: state.writable, updatedAt: state.updatedAt,
      systemMail: systemMailState(state.mail), cloudBackup: state.cloudBackup,
      mailboxRetired: true
    }
  })

  fastify.put('/admin/integrations/system-mail', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const input = normalizeSystemMailInput(request.body)
      const mail = await withManagedIntegrationMutation(async () => {
        const persistence = await snapshotManagedMailPersistence()
        const runtime = snapshotManagedMailRuntimeConfig()
        try {
          const saved = await saveManagedMailConfig(input)
          await applyManagedIntegrationsToRuntime()
          enforceMailboxRetirement(config)
          await refreshSystemMailRuntime()
          return saved
        } catch (error) {
          await suspendSystemMailRuntime()
          await restoreManagedMailPersistence(persistence)
          restoreManagedMailRuntimeConfig(runtime)
          enforceMailboxRetirement(config)
          await refreshSystemMailRuntime()
          throw error
        }
      })
      await audit(request, 'admin.integrations.system_mail.updated', 'system_mail')
      return { systemMail: systemMailState(mail), applied: true }
    } catch (error) {
      await audit(request, 'admin.integrations.system_mail.updated', 'system_mail', 'failure')
      reply.code(error instanceof TypeError ? 400 : 503)
      return { error: safeConnectionError(error, '系统通知配置保存或应用失败，请检查服务器配置。') }
    }
  })

  fastify.post('/admin/integrations/system-mail/test-smtp', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const result = await withManagedIntegrationMutation(async () => {
        await verifySmtpConnection(config)
        return markManagedMailVerified('smtp')
      })
      await audit(request, 'admin.integrations.system_mail.tested', 'system_mail')
      return { systemMail: systemMailState(result) }
    } catch {
      reply.code(502)
      return { error: 'SMTP 连接验证失败，请核对主机、账号、密码与 TLS 端口。' }
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
