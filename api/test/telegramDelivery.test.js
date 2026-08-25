import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  callTelegram,
  verifyTelegramConfigDelivery
} from '../src/lib/telegramClient.js'

function telegramResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('Telegram configuration test verifies the bot and delivers to the exact Chat ID', async () => {
  const originalFetch = globalThis.fetch
  const calls = []

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) {
      return telegramResponse({
        ok: true,
        result: { id: 123, username: 'domo_nav_bot' }
      })
    }
    return telegramResponse({
      ok: true,
      result: {
        message_id: 456,
        chat: { id: -100123456 }
      }
    })
  }

  try {
    const result = await verifyTelegramConfigDelivery({
      botToken: 'test-bot-token',
      adminChatId: '-100123456'
    })

    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /\/bottest-bot-token\/getMe$/)
    assert.equal(calls[0].options.method, 'GET')
    assert.match(calls[1].url, /\/bottest-bot-token\/sendMessage$/)
    assert.equal(calls[1].options.method, 'POST')

    const payload = JSON.parse(calls[1].options.body)
    assert.equal(payload.chat_id, '-100123456')
    assert.match(payload.text, /DOMO NAV Telegram 测试消息/)
    assert.match(payload.text, /Bot Token 与管理员 Chat ID 均已验证可用/)

    assert.deepEqual(result, {
      ok: true,
      result: { id: 123, username: 'domo_nav_bot' },
      delivery: { sent: true, messageId: 456 }
    })
    assert.doesNotMatch(JSON.stringify(result), /test-bot-token|-100123456/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Telegram configuration test fails when the target Chat ID cannot receive a message', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = async () => {
    callCount += 1
    if (callCount === 1) {
      return telegramResponse({
        ok: true,
        result: { id: 123, username: 'domo_nav_bot' }
      })
    }
    return telegramResponse({
      ok: false,
      error_code: 400,
      description: 'Bad Request: chat not found'
    }, 400)
  }

  try {
    await assert.rejects(
      verifyTelegramConfigDelivery({
        botToken: 'test-bot-token',
        adminChatId: '-100999999'
      }),
      /chat not found/
    )
    assert.equal(callCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Telegram client rejects HTTP 200 responses without a valid Telegram success envelope', async () => {
  const originalFetch = globalThis.fetch
  const invalidBodies = [
    new Response('', { status: 200 }),
    new Response('{not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }),
    telegramResponse({ result: { id: 123 } })
  ]

  try {
    for (const response of invalidBodies) {
      globalThis.fetch = async () => response
      await assert.rejects(
        callTelegram('test-bot-token', 'getMe'),
        /invalid response/
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Telegram configuration test rejects an invalid bot identity', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => telegramResponse({ ok: true, result: {} })

  try {
    await assert.rejects(
      verifyTelegramConfigDelivery({
        botToken: 'test-bot-token',
        adminChatId: '-100123456'
      }),
      /bot identity response was invalid/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Telegram configuration test requires a message ID and the exact returned Chat ID', async () => {
  const originalFetch = globalThis.fetch
  const invalidDeliveries = [
    { ok: true, result: { chat: { id: -100123456 } } },
    { ok: true, result: { message_id: 456, chat: { id: -100654321 } } }
  ]

  try {
    for (const invalidDelivery of invalidDeliveries) {
      let callCount = 0
      globalThis.fetch = async () => {
        callCount += 1
        return callCount === 1
          ? telegramResponse({
              ok: true,
              result: { id: 123, username: 'domo_nav_bot' }
            })
          : telegramResponse(invalidDelivery)
      }

      await assert.rejects(
        verifyTelegramConfigDelivery({
          botToken: 'test-bot-token',
          adminChatId: '-100123456'
        }),
        /delivery confirmation/
      )
      assert.equal(callCount, 2)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Telegram configuration test rejects a non-numeric Chat ID before making a request', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  globalThis.fetch = async () => {
    callCount += 1
    return telegramResponse({ ok: true, result: { id: 123 } })
  }

  try {
    await assert.rejects(
      verifyTelegramConfigDelivery({
        botToken: 'test-bot-token',
        adminChatId: '@admin-channel'
      }),
      /numeric identifier/
    )
    assert.equal(callCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('legacy Telegram delivery stays compatible while current settings use generic mail', async () => {
  const [localService, settingsView] = await Promise.all([
    fs.readFile(
      fileURLToPath(new URL('../../app/src/shared/services/telegramApproval.js', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/settings/components/UserManagementSettings.vue', import.meta.url)),
      'utf8'
    )
  ])

  assert.match(localService, /\/api\/telegram\/get-me/)
  assert.match(localService, /\/api\/telegram\/send-message/)
  assert.match(localService, /chatId:\s*expectedChatId/)
  assert.match(localService, /delivery\.result\?\.chat\?\.id/)
  assert.match(settingsView, /邮件通知通道/)
  assert.match(settingsView, /发送测试邮件/)
  assert.doesNotMatch(settingsView, /发送测试消息|测试消息已送达/)
})
