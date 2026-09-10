import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { query } from '../db/index.js'
import { enqueueMail, normalizeEmailAddress } from './mailOutbox.js'
import { createAdminNotifications } from './notifications.js'

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeOrigin() {
  return String(config.publicAppOrigin || 'https://nav.skrskr.net').replace(/\/$/, '')
}

async function adminRecipients() {
  const rows = await query(
    `SELECT email FROM users
     WHERE role = 'admin' AND status = 'approved' AND email IS NOT NULL`
  )
  const recipients = [...config.adminEmailRecipients, ...rows.rows.map((row) => row.email)]
  return [...new Set(recipients.map((value) => {
    try { return normalizeEmailAddress(value) } catch { return '' }
  }).filter(Boolean))]
}

async function queueAdminMail({ messageType, subject, textBody, htmlBody, dedupePrefix }) {
  const recipients = await adminRecipients()
  const queued = []
  for (const recipient of recipients) {
    const recipientDigest = createHash('sha256').update(recipient).digest('hex').slice(0, 24)
    queued.push(await enqueueMail({
      messageType,
      recipient,
      subject,
      textBody,
      htmlBody,
      dedupeKey: `${dedupePrefix}:recipient-${recipientDigest}`,
      sensitive: true
    }))
  }
  return queued
}

export async function notifyRegistrationRequestToAdmins(registration) {
  const username = String(registration.username || '').slice(0, 128)
  const requestId = String(registration.id || '')
  const email = String(registration.email || '')
  const actionUrl = `/settings?category=users&request=${encodeURIComponent(requestId)}`
  const notifications = await createAdminNotifications({
    eventType: 'registration.requested',
    title: '新的注册申请',
    summary: `${username} 已完成邮箱验证，等待审批。`,
    sourceType: 'registration',
    sourceId: requestId,
    actionUrl,
    dedupeKey: `registration:${requestId}`,
    sensitive: true,
    metadata: { username }
  })
  const subject = `DOMO NAV 注册申请：${username}`
  const textBody = [
    'DOMO NAV 收到新的注册申请。',
    `用户名：${username}`,
    `邮箱：${email}`,
    `申请编号：${requestId}`,
    '',
    '请登录 DOMO NAV 设置页完成审批。邮件不提供免登录的一键批准。',
    `${safeOrigin()}${actionUrl}`
  ].join('\n')
  const htmlBody = `<p>DOMO NAV 收到新的注册申请。</p><ul><li>用户名：${escapeHtml(username)}</li><li>邮箱：${escapeHtml(email)}</li><li>申请编号：${escapeHtml(requestId)}</li></ul><p><a href="${safeOrigin()}${actionUrl}">登录 DOMO NAV 完成审批</a></p><p>为避免越权，本邮件不提供免登录的一键批准。</p>`
  const mails = await queueAdminMail({
    messageType: 'registration.requested',
    subject,
    textBody,
    htmlBody,
    dedupePrefix: `registration-request:${requestId}`
  })
  return { notifications: notifications.length, mails: mails.length }
}

export async function queueRegistrationVerification(registration, token) {
  const requestId = String(registration.id || '')
  const username = String(registration.username || '').slice(0, 128)
  const recipient = normalizeEmailAddress(registration.email)
  // Keep the one-time token in the URL fragment. Fragments are not sent to
  // Nginx, Fastify, access logs or referrer headers; the browser posts it once.
  const query = new URLSearchParams({ request: requestId, token: String(token) })
  const verifyUrl = `${safeOrigin()}/auth#register-verify?${query.toString()}`
  const tokenDigest = createHash('sha256').update(String(token)).digest('hex').slice(0, 24)
  return enqueueMail({
    messageType: 'registration.verify',
    recipient,
    subject: '验证你的 DOMO NAV 注册邮箱',
    textBody: [
      `你好，${username}：`,
      '',
      '请打开下面的链接验证邮箱，验证后申请才会进入管理员审批队列：',
      verifyUrl,
      '',
      `链接将在 ${config.registrationEmailVerificationMinutes} 分钟后失效。若非本人操作，请忽略。`
    ].join('\n'),
    htmlBody: `<p>你好，${escapeHtml(username)}：</p><p>请验证邮箱，验证后申请才会进入管理员审批队列。</p><p><a href="${escapeHtml(verifyUrl)}">验证注册邮箱</a></p><p>链接将在 ${Number(config.registrationEmailVerificationMinutes)} 分钟后失效。若非本人操作，请忽略。</p>`,
    // Each rotated token must create a new outbox row. Reusing the request id
    // alone would silently retain the expired message because mail_outbox is
    // idempotent by dedupe_key.
    dedupeKey: `registration-verify:${requestId}:${tokenDigest}`,
    sensitive: true
  })
}

export async function queueRegistrationDecision(registration, decision, { queryFn = query } = {}) {
  if (!registration?.email) return { skipped: true }
  const approved = decision === 'approved'
  const username = String(registration.username || '').slice(0, 128)
  const subject = approved ? '你的 DOMO NAV 注册申请已批准' : '你的 DOMO NAV 注册申请未通过'
  const textBody = approved
    ? `你好，${username}：\n\n你的 DOMO NAV 注册申请已批准，现在可以登录：\n${safeOrigin()}/auth`
    : `你好，${username}：\n\n你的 DOMO NAV 注册申请未通过。如需了解原因，请联系站点管理员。`
  return enqueueMail({
    messageType: `registration.${approved ? 'approved' : 'rejected'}`,
    recipient: registration.email,
    subject,
    textBody,
    htmlBody: approved
      ? `<p>你好，${escapeHtml(username)}：</p><p>你的 DOMO NAV 注册申请已批准。</p><p><a href="${safeOrigin()}/auth">现在登录</a></p>`
      : `<p>你好，${escapeHtml(username)}：</p><p>你的 DOMO NAV 注册申请未通过。如需了解原因，请联系站点管理员。</p>`,
    dedupeKey: `registration-decision:${registration.id}:${approved ? 'approved' : 'rejected'}`,
    sensitive: true,
    queryFn
  })
}

export async function updateRegistrationNotification(registration, decision, { queryFn = query } = {}) {
  const label = decision === 'approved' ? '已批准' : '已拒绝'
  await queryFn(
    `UPDATE notifications SET title = $2, summary = $3,
      metadata = metadata || $4::jsonb, push_enabled = FALSE, updated_at = NOW()
     WHERE source_type = 'registration' AND source_id = $1 AND event_type = 'registration.requested'`,
    [String(registration.id), `注册申请${label}`, `${String(registration.username || '').slice(0, 128)} 的申请${label}。`, JSON.stringify({ registrationStatus: decision })]
  )
}

export async function sendMaintenanceNotification({
  jobName,
  jobLabel,
  kind,
  occurredAt,
  consecutiveFailures,
  errorCode
}) {
  const recovery = kind === 'recovery'
  const summary = recovery
    ? `${jobLabel} 已恢复。`
    : `${jobLabel} 已连续失败 ${Number(consecutiveFailures || 0)} 次，错误代码 ${errorCode || 'UNEXPECTED_ERROR'}。`
  const notificationRows = await createAdminNotifications({
    eventType: recovery ? 'maintenance.recovered' : 'maintenance.failed',
    title: recovery ? '后台任务已恢复' : '后台任务连续失败',
    summary,
    sourceType: 'maintenance',
    sourceId: jobName,
    actionUrl: '/settings?category=security',
    dedupeKey: `maintenance:${jobName}:${kind}:${new Date(occurredAt).toISOString()}`,
    sensitive: true,
    metadata: { jobName, errorCode: errorCode || null }
  })

  // A broken SMTP worker cannot reliably alert through the same SMTP queue.
  // The in-app notification and Web Push remain available for that one job.
  let mails = []
  if (jobName !== 'mail_delivery') {
    mails = await queueAdminMail({
      messageType: recovery ? 'maintenance.recovered' : 'maintenance.failed',
      subject: recovery ? `DOMO NAV 后台任务已恢复：${jobLabel}` : `DOMO NAV 后台任务失败：${jobLabel}`,
      textBody: [summary, `发生时间：${new Date(occurredAt).toISOString()}`, '', `${safeOrigin()}/settings?category=security`].join('\n'),
      htmlBody: `<p>${escapeHtml(summary)}</p><p>发生时间：${escapeHtml(new Date(occurredAt).toISOString())}</p><p><a href="${safeOrigin()}/settings?category=security">查看后台状态</a></p>`,
      dedupePrefix: `maintenance:${jobName}:${kind}:${new Date(occurredAt).toISOString()}`
    })
  }
  const sent = notificationRows.length + mails.length
  return { skipped: sent === 0, sent, failed: 0 }
}
