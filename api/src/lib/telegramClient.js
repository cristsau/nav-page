const TELEGRAM_REQUEST_TIMEOUT_MS = 10000

function formatTestDate(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function normalizeTelegramChatId(value) {
  const chatId = String(value ?? '').trim()
  if (!/^-?[1-9]\d*$/.test(chatId)) {
    throw new TypeError('Telegram Chat ID must be a numeric identifier')
  }
  return chatId
}

function requireSafeInteger(value, responseName) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Telegram ${responseName} response was invalid`)
  }
  return parsed
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

  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok !== true) {
    throw new Error(
      data?.description
      || (response.ok
        ? 'Telegram returned an invalid response'
        : `Telegram request failed: ${response.status}`)
    )
  }

  return data
}

export async function verifyTelegramConfigDelivery({ botToken, adminChatId }) {
  const expectedChatId = normalizeTelegramChatId(adminChatId)
  const bot = await callTelegram(botToken, 'getMe')
  requireSafeInteger(bot.result?.id, 'bot identity')
  const delivery = await callTelegram(botToken, 'sendMessage', {
    chat_id: expectedChatId,
    text: [
      'DOMO NAV Telegram 测试消息',
      '',
      'Bot Token 与管理员 Chat ID 均已验证可用。',
      `测试时间: ${formatTestDate(new Date())}`
    ].join('\n')
  })

  const messageId = requireSafeInteger(delivery.result?.message_id, 'delivery confirmation')
  const deliveredChatId = String(delivery.result?.chat?.id ?? '').trim()
  if (deliveredChatId !== expectedChatId) {
    throw new Error('Telegram delivery confirmation did not match the configured Chat ID')
  }

  return {
    ok: true,
    result: bot.result || null,
    delivery: {
      sent: true,
      messageId
    }
  }
}
