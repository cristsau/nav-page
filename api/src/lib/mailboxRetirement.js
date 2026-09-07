// The personal mailbox is retired. This is a product boundary, not an env toggle.
export const RETIRED_MAIL_TOOLS = new Set([
  'list_email_accounts', 'list_email_drafts', 'create_email_draft', 'send_email_draft'
])
export const SYSTEM_MAIL_TYPES = Object.freeze([
  'registration.requested', 'registration.verify', 'registration.approved',
  'registration.rejected', 'maintenance.failed', 'maintenance.recovered', 'system.test'
])
export const SYSTEM_MAIL_SQL = `mail_outbox.message_type IN (${SYSTEM_MAIL_TYPES.map((type) => `'${type}'`).join(', ')})`
export const ACTIVE_NOTIFICATION_SQL = "(source_type IS NULL OR source_type NOT IN ('email', 'email_digest'))"

export function assertActiveAssistantTool(toolName) {
  if (!RETIRED_MAIL_TOOLS.has(String(toolName || ''))) return
  const error = new Error('邮箱功能已下线，无法读取或发送邮件。')
  error.code = 'MAILBOX_RETIRED'
  error.statusCode = 410
  throw error
}

export function enforceMailboxRetirement(runtimeConfig) {
  Object.assign(runtimeConfig, {
    emailIngestEnabled: false,
    emailDigestEnabled: false,
    emailSentAppendEnabled: false,
    emailCacheRetentionEnabled: false,
    imapProtocolReconciliationEnabled: false,
    imapSecondaryFolderSyncEnabled: false
  })
  return runtimeConfig
}

export function mailboxRetiredResponse(_request, reply) {
  return reply.code(410).header('Cache-Control', 'no-store').send({
    code: 'MAILBOX_RETIRED',
    error: 'DOMO NAV 邮箱功能已下线，请使用原邮箱服务。'
  })
}
