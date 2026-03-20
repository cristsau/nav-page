import {
  getMeta,
  setMeta,
  findRegistrationRequestById,
  approveRegistration,
  rejectRegistration,
  getTelegramConfig
} from '@/shared/db/database'

const TELEGRAM_UPDATE_OFFSET_KEY = 'telegram-update-offset'

async function getEnabledTelegramConfig() {
  const config = await getTelegramConfig()

  if (!config.enabled || !config.botToken || !config.adminChatId) {
    return null
  }

  return config
}

async function requestTelegram(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload || {})
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Telegram request failed: ${response.status}`)
  }

  return response.json()
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

export async function testTelegramConfig(config) {
  if (!config?.botToken || !config?.adminChatId) {
    throw new Error('请先填写 Bot Token 和管理员 Chat ID')
  }

  return requestTelegram('/api/telegram/get-me', {
    botToken: config.botToken
  })
}

export async function sendRegistrationNotification(request) {
  const config = await getEnabledTelegramConfig()
  if (!config) return { skipped: true }

  const text = [
    'NAV 收到新的注册申请',
    `用户名: ${request.username}`,
    `申请编号: ${request.id}`,
    `提交时间: ${formatDate(request.createdAt)}`,
    '',
    `批准命令: /approve ${request.id}`,
    `拒绝命令: /reject ${request.id}`
  ].join('\n')

  return requestTelegram('/api/telegram/send-message', {
    botToken: config.botToken,
    chatId: config.adminChatId,
    text
  })
}

export async function sendDecisionNotification(request, decision) {
  const config = await getEnabledTelegramConfig()
  if (!config) return { skipped: true }

  const actionText = decision === 'approved' ? '已批准' : '已拒绝'
  const text = [
    `NAV 注册申请${actionText}`,
    `用户名: ${request.username}`,
    `申请编号: ${request.id}`,
    `处理时间: ${formatDate(request.updatedAt)}`,
    `处理人: ${request.decidedBy || 'admin'}`
  ].join('\n')

  return requestTelegram('/api/telegram/send-message', {
    botToken: config.botToken,
    chatId: config.adminChatId,
    text
  })
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

async function sendSyncResultMessage(config, text) {
  return requestTelegram('/api/telegram/send-message', {
    botToken: config.botToken,
    chatId: config.adminChatId,
    text
  })
}

export async function syncTelegramApprovals() {
  const config = await getEnabledTelegramConfig()
  if (!config) {
    return {
      updates: 0,
      processed: [],
      skipped: true
    }
  }

  const offset = (await getMeta(TELEGRAM_UPDATE_OFFSET_KEY)) || 0
  const data = await requestTelegram('/api/telegram/get-updates', {
    botToken: config.botToken,
    offset,
    limit: 20
  })

  const updates = data.result || []
  const processed = []
  let nextOffset = offset

  for (const update of updates) {
    nextOffset = Math.max(nextOffset, Number(update.update_id || 0) + 1)
    const command = parseDecisionCommand(update, config.adminChatId)

    if (!command) {
      continue
    }

    const request = await findRegistrationRequestById(command.requestId)

    if (!request) {
      await sendSyncResultMessage(config, `未找到申请编号 ${command.requestId}`)
      continue
    }

    if (request.status !== 'pending') {
      await sendSyncResultMessage(config, `申请 ${command.requestId} 当前状态为 ${request.status}，无需重复处理`)
      continue
    }

    if (command.action === 'approve') {
      await approveRegistration(command.requestId, 'telegram-admin')
      await sendSyncResultMessage(config, `已批准 ${request.username} (${command.requestId})`)
      processed.push({ requestId: command.requestId, username: request.username, action: 'approved' })
    } else {
      await rejectRegistration(command.requestId, 'telegram-admin')
      await sendSyncResultMessage(config, `已拒绝 ${request.username} (${command.requestId})`)
      processed.push({ requestId: command.requestId, username: request.username, action: 'rejected' })
    }
  }

  await setMeta(TELEGRAM_UPDATE_OFFSET_KEY, nextOffset)

  return {
    updates: updates.length,
    processed,
    skipped: false
  }
}
