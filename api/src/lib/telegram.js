import { query } from '../db/index.js'
import { getUserSettingValue, setUserSettingValue } from './userSettings.js'

const TELEGRAM_CONFIG_KEY = 'telegramConfig'
const TELEGRAM_UPDATE_OFFSET_KEY = 'telegramUpdateOffset'
const TELEGRAM_REQUEST_TIMEOUT_MS = 10000

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function normalizeTelegramConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    botToken: String(config.botToken || '').trim(),
    adminChatId: String(config.adminChatId || '').trim()
  }
}

export async function callTelegram(botToken, method, payload = {}) {
  const hasPayload = payload && Object.keys(payload).length > 0
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: hasPayload ? 'POST' : 'GET',
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    headers: hasPayload
      ? {
          'Content-Type': 'application/json'
        }
      : undefined,
    body: hasPayload ? JSON.stringify(payload) : undefined
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram request failed: ${response.status}`)
  }

  return data
}

export async function getAdminTelegramConfig(userId) {
  const value = await getUserSettingValue(userId, TELEGRAM_CONFIG_KEY, {
    enabled: false,
    botToken: '',
    adminChatId: ''
  })

  return normalizeTelegramConfig(value)
}

export async function saveAdminTelegramConfig(userId, config, options = {}) {
  const normalized = normalizeTelegramConfig(config)
  const record = await setUserSettingValue(
    userId,
    TELEGRAM_CONFIG_KEY,
    normalized,
    options
  )
  return {
    key: record.key,
    value: record.value,
    updatedAt: record.updated_at
  }
}

export async function testAdminTelegramConfig(config) {
  const normalized = normalizeTelegramConfig(config)
  if (!normalized.botToken || !normalized.adminChatId) {
    throw new Error('Bot Token and Chat ID are required')
  }

  return callTelegram(normalized.botToken, 'getMe')
}

export async function getEnabledAdminTelegramTargets() {
  const { rows } = await query(
    `
      SELECT u.id, u.username, s.value
      FROM users u
      JOIN user_settings s
        ON s.user_id = u.id
       AND s.key = $1
      WHERE u.role = 'admin'
        AND u.status = 'approved'
    `,
    [TELEGRAM_CONFIG_KEY]
  )

  return rows
    .map((row) => ({
      id: row.id,
      username: row.username,
      config: normalizeTelegramConfig(row.value)
    }))
    .filter((item) => item.config.enabled && item.config.botToken && item.config.adminChatId)
}

export async function sendRegistrationNotificationToAdmins(requestRecord) {
  const targets = await getEnabledAdminTelegramTargets()
  if (!targets.length) {
    return { skipped: true, sent: 0 }
  }

  const text = [
    'DOMO NAV 收到新的注册申请',
    `用户名: ${requestRecord.username}`,
    `申请编号: ${requestRecord.id}`,
    `提交时间: ${formatDate(requestRecord.created_at || requestRecord.createdAt)}`,
    '',
    `批准命令: /approve ${requestRecord.id}`,
    `拒绝命令: /reject ${requestRecord.id}`
  ].join('\n')

  await Promise.all(targets.map((target) =>
    callTelegram(target.config.botToken, 'sendMessage', {
      chat_id: target.config.adminChatId,
      text
    })
  ))

  return { skipped: false, sent: targets.length }
}

export async function sendDecisionNotificationToAdmins(requestRecord, decisionLabel) {
  const targets = await getEnabledAdminTelegramTargets()
  if (!targets.length) {
    return { skipped: true, sent: 0 }
  }

  const text = [
    `DOMO NAV 注册申请已${decisionLabel}`,
    `用户名: ${requestRecord.username}`,
    `申请编号: ${requestRecord.id}`,
    `处理时间: ${formatDate(requestRecord.updated_at || requestRecord.updatedAt)}`,
    `处理人: ${requestRecord.decided_by || requestRecord.decidedBy || 'admin'}`
  ].join('\n')

  await Promise.all(targets.map((target) =>
    callTelegram(target.config.botToken, 'sendMessage', {
      chat_id: target.config.adminChatId,
      text
    })
  ))

  return { skipped: false, sent: targets.length }
}

export async function sendMaintenanceJobNotificationToAdmins({
  jobLabel,
  kind,
  occurredAt,
  consecutiveFailures,
  errorCode
}) {
  const targets = await getEnabledAdminTelegramTargets()
  if (!targets.length) {
    return { skipped: true, sent: 0, failed: 0 }
  }

  const text = kind === 'recovery'
    ? [
        'DOMO NAV 后台任务已恢复',
        `任务: ${jobLabel}`,
        `恢复时间: ${formatDate(occurredAt)}`
      ].join('\n')
    : [
        'DOMO NAV 后台任务连续失败',
        `任务: ${jobLabel}`,
        `连续失败: ${Number(consecutiveFailures || 0)} 次`,
        `错误代码: ${errorCode || 'UNEXPECTED_ERROR'}`,
        `发生时间: ${formatDate(occurredAt)}`,
        '',
        '请登录 NAV 设置查看后台维护状态。'
      ].join('\n')

  const results = await Promise.allSettled(targets.map((target) =>
    callTelegram(target.config.botToken, 'sendMessage', {
      chat_id: target.config.adminChatId,
      text
    })
  ))
  const sent = results.filter((result) => result.status === 'fulfilled').length
  const failed = results.length - sent

  return { skipped: false, sent, failed }
}

function parseDecisionCommand(update, adminChatId) {
  const message = update?.message
  const text = message?.text?.trim()
  const chatId = String(message?.chat?.id || '')

  if (!text || chatId !== String(adminChatId)) {
    return null
  }

  const match = text.match(/^\/?(approve|reject|批准|拒绝)\s+([A-Za-z0-9-]+)$/i)
  if (!match) return null

  const rawAction = match[1].toLowerCase()
  return {
    action: rawAction === 'approve' || rawAction === '批准' ? 'approve' : 'reject',
    requestId: match[2]
  }
}

async function sendSyncResultMessage(target, text) {
  return callTelegram(target.config.botToken, 'sendMessage', {
    chat_id: target.config.adminChatId,
    text
  })
}

export async function syncTelegramApprovalsForAdmin({
  adminUserId,
  onApprove,
  onReject,
  onFindRequest
}) {
  const config = await getAdminTelegramConfig(adminUserId)
  if (!config.enabled || !config.botToken || !config.adminChatId) {
    return {
      updates: 0,
      processed: [],
      skipped: true
    }
  }

  const offset = Number(await getUserSettingValue(adminUserId, TELEGRAM_UPDATE_OFFSET_KEY, 0)) || 0
  const data = await callTelegram(config.botToken, 'getUpdates', {
    offset,
    limit: 20
  })

  const updates = data.result || []
  const processed = []
  let nextOffset = offset
  const target = { config }

  for (const update of updates) {
    nextOffset = Math.max(nextOffset, Number(update.update_id || 0) + 1)
    const command = parseDecisionCommand(update, config.adminChatId)

    if (!command) {
      continue
    }

    const requestRecord = await onFindRequest(command.requestId)
    if (!requestRecord) {
      await sendSyncResultMessage(target, `未找到申请编号: ${command.requestId}`)
      continue
    }

    if (requestRecord.status !== 'pending') {
      await sendSyncResultMessage(target, `申请 ${command.requestId} 当前状态为 ${requestRecord.status}，无需重复处理`)
      continue
    }

    if (command.action === 'approve') {
      await onApprove(command.requestId)
      await sendSyncResultMessage(target, `已批准 ${requestRecord.username} (${command.requestId})`)
      processed.push({ requestId: command.requestId, username: requestRecord.username, action: 'approved' })
    } else {
      await onReject(command.requestId)
      await sendSyncResultMessage(target, `已拒绝 ${requestRecord.username} (${command.requestId})`)
      processed.push({ requestId: command.requestId, username: requestRecord.username, action: 'rejected' })
    }
  }

  await setUserSettingValue(adminUserId, TELEGRAM_UPDATE_OFFSET_KEY, nextOffset)

  return {
    updates: updates.length,
    processed,
    skipped: false
  }
}
