import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk
    })

    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function isExplicitlyEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function createTelegramProxyPlugin(env) {
  return {
    name: 'telegram-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/telegram/send-message', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = await readJsonBody(req)
          const botToken = body.botToken || env.TELEGRAM_BOT_TOKEN
          const chatId = body.chatId || body.adminChatId || env.TELEGRAM_ADMIN_CHAT_ID

          if (!botToken || !chatId) {
            sendJson(res, 400, { ok: false, error: '缺少 Telegram Bot Token 或 Chat ID' })
            return
          }

          const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: body.text || ''
            })
          })

          sendJson(res, response.ok ? 200 : response.status, await response.json())
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      })

      server.middlewares.use('/api/telegram/get-updates', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = await readJsonBody(req)
          const botToken = body.botToken || env.TELEGRAM_BOT_TOKEN

          if (!botToken) {
            sendJson(res, 400, { ok: false, error: '缺少 Telegram Bot Token' })
            return
          }

          const offset = body.offset || 0
          const limit = body.limit || 20
          const response = await fetch(
            `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&limit=${limit}&timeout=0`
          )

          sendJson(res, response.ok ? 200 : response.status, await response.json())
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      })

      server.middlewares.use('/api/telegram/get-me', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        try {
          const body = await readJsonBody(req)
          const botToken = body.botToken || env.TELEGRAM_BOT_TOKEN

          if (!botToken) {
            sendJson(res, 400, { ok: false, error: '缺少 Telegram Bot Token' })
            return
          }

          const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
          sendJson(res, response.ok ? 200 : response.status, await response.json())
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message })
        }
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const plugins = [vue()]

  if (isExplicitlyEnabled(env.NAV_ENABLE_TELEGRAM_DEV_PROXY)) {
    plugins.push(createTelegramProxyPlugin(env))
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      open: false
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  }
})
