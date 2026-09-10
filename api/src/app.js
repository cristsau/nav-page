import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { config } from './config.js'
import { mailboxRetiredResponse } from './lib/mailboxRetirement.js'
import { BotGuardError } from './lib/botGuard.js'
import {
  createCorsOriginValidator,
  isUnsafeRequestOriginTrusted
} from './lib/requestSecurity.js'
import { isTrustedProxyAddress } from './lib/requestRateLimit.js'
import authPlugin from './plugins/auth.js'
import adminTelegramRoutes from './routes/adminTelegram.js'
import aiSearchRoutes from './routes/aiSearch.js'
import aiUsageRoutes from './routes/aiUsage.js'
import authRoutes from './routes/auth.js'
import authEmailRoutes from './routes/authEmail.js'
import assistantRoutes from './routes/assistant.js'
import collaborationRoutes from './routes/collaboration.js'
import customSearchEngineRoutes from './routes/customSearchEngines.js'
import migrationRoutes from './routes/migration.js'
import maintenanceRoutes from './routes/maintenance.js'
import mediaRoutes from './routes/media.js'
import navigationRoutes from './routes/navigation.js'
import notificationsRoutes from './routes/notifications.js'
import integrationRoutes from './routes/systemIntegrations.js'
import noteAiRoutes from './routes/noteAi.js'
import noteImagesRoutes from './routes/noteImages.js'
import noteReminderRoutes from './routes/noteReminders.js'
import notesRoutes from './routes/notes.js'
import offlineSyncRoutes from './routes/offlineSync.js'
import passkeyRoutes from './routes/passkeys.js'
import deviceKeyRoutes from './routes/deviceKeys.js'
import oauthRoutes from './routes/oauth.js'
import publicSharePageRoutes from './routes/publicSharePage.js'
import productivityImportRoutes from './routes/productivityImports.js'
import securityEventRoutes from './routes/securityEvents.js'
import settingsRoutes from './routes/settings.js'
import workspaceRoutes from './routes/workspace.js'
import workspaceDatabaseRoutes from './routes/workspaceDatabases.js'
import webPushRoutes from './routes/webPush.js'

function stripBodylessDeleteJsonContentType(request) {
  if (String(request.raw.method || '').toUpperCase() !== 'DELETE') {
    return
  }

  const headers = request.raw.headers || {}
  const contentType = String(headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  const contentLength = headers['content-length']
  const transferEncoding = headers['transfer-encoding']
  const isJson = contentType === 'application/json' || contentType.endsWith('+json')
  const isBodyless = !transferEncoding && (
    contentLength === undefined
    || String(contentLength).trim() === ''
    || String(contentLength).trim() === '0'
  )

  if (isJson && isBodyless) {
    delete headers['content-type']
  }
}

export function createApp() {
  const app = Fastify({
    logger: {
      level: config.apiLogLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'req.url',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.confirmPassword',
          'req.body.code',
          'req.body.challengeId',
          'req.body.recoveryCode',
          'req.body.apiKey',
          'req.body.smtpPassword',
          'req.body.imapPassword',
          'req.body.accessKeyId',
          'req.body.secretAccessKey',
          'req.body.sessionToken',
          'req.body.clientSecret',
          'req.body.refreshToken',
          'req.body.*.clientSecret',
          'req.body.*.refreshToken',
          'req.query.code',
          'req.query.state',
          'req.body.token',
          'req.body.launch',
          'req.body.turnstileToken',
          'req.body.email',
          'req.body.planToken',
          'req.body.backupReceipt',
          'req.body.backup',
          'req.body.response',
          'req.body.subscription.endpoint',
          'req.body.subscription.keys.p256dh',
          'req.body.subscription.keys.auth',
          'req.body.query',
          'req.body.to',
          'req.body.cc',
          'req.body.bcc',
          'req.body.subject',
          'req.body.text',
          'req.body.body',
          'req.body.instruction',
          'res.headers["set-cookie"]',
          'authorization',
          'cookie',
          'password',
          'token',
          'planToken',
          'backupReceipt',
          'backup',
          'apiKey',
          'api_key'
        ],
        censor: '[Redacted]'
      }
    },
    trustProxy: (address) => isTrustedProxyAddress(address)
  })

  app.register(cookie)
  app.register(cors, {
    origin: createCorsOriginValidator(config.corsOrigin, config.extensionOrigins),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Accept', 'Authorization', 'Content-Type', 'X-File-Name']
  })

  app.register(authPlugin)

  app.addHook('onRequest', async (request, reply) => {
    stripBodylessDeleteJsonContentType(request)

    if (!isUnsafeRequestOriginTrusted(
      request,
      config.corsOrigin,
      config.extensionOrigins
    )) {
      reply.code(403)
      return reply.send({
        error: 'Cross-site request blocked'
      })
    }
  })

  app.get('/health', async () => ({
    ok: true,
    service: 'nav-api'
  }))

  app.get('/api/health', async () => ({
    ok: true,
    service: 'nav-api'
  }))

  app.register(publicSharePageRoutes)
  app.register(assistantRoutes, { prefix: '/api' })
  app.register(securityEventRoutes, { prefix: '/api' })
  app.register(adminTelegramRoutes, { prefix: '/api' })
  app.register(aiSearchRoutes, { prefix: '/api' })
  app.register(aiUsageRoutes, { prefix: '/api' })
  app.register(authRoutes, { prefix: '/api' })
  app.register(authEmailRoutes, { prefix: '/api' })
  app.register(collaborationRoutes, { prefix: '/api' })
  app.register(customSearchEngineRoutes, { prefix: '/api' })
  app.register(migrationRoutes, { prefix: '/api' })
  app.register(maintenanceRoutes, { prefix: '/api' })
  app.register(mediaRoutes, { prefix: '/api' })
  app.register(navigationRoutes, { prefix: '/api' })
  app.register(notificationsRoutes, { prefix: '/api' })
  for (const prefix of ['/api/email', '/api/admin/email', '/api/admin/integrations/mail', '/api/admin/oauth-integrations/email']) {
    app.all(prefix, mailboxRetiredResponse)
    app.all(`${prefix}/*`, mailboxRetiredResponse)
  }
  app.register(integrationRoutes, { prefix: '/api' })
  app.register(noteAiRoutes, { prefix: '/api' })
  app.register(noteImagesRoutes, { prefix: '/api' })
  app.register(noteReminderRoutes, { prefix: '/api' })
  app.register(notesRoutes, { prefix: '/api' })
  app.register(offlineSyncRoutes, { prefix: '/api' })
  app.register(passkeyRoutes, { prefix: '/api' })
  app.register(deviceKeyRoutes, { prefix: '/api' })
  app.register(oauthRoutes, { prefix: '/api' })
  app.register(productivityImportRoutes, { prefix: '/api' })
  app.register(settingsRoutes, { prefix: '/api' })
  app.register(workspaceRoutes, { prefix: '/api' })
  app.register(workspaceDatabaseRoutes, { prefix: '/api' })
  app.register(webPushRoutes, { prefix: '/api' })

  app.setErrorHandler((error, request, reply) => {
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400
      ? error.statusCode
      : reply.statusCode >= 400
        ? reply.statusCode
        : 500

    if (statusCode >= 500) {
      request.log.error(error)
    } else {
      request.log.warn(error)
    }

    // Only allow the explicit public challenge contract to describe a 5xx failure.
    // Database/provider messages may contain internal SQL or sensitive details.
    const publicBotGuardError = error instanceof BotGuardError && [
      'BOT_CHALLENGE_REQUIRED', 'BOT_CHALLENGE_INVALID',
      'BOT_ORIGIN_INVALID', 'BOT_GUARD_UNAVAILABLE'
    ].includes(error.code)
    const body = {
      error: statusCode >= 500
        ? '服务暂时不可用，请稍后重试。'
        : error.message || 'Request failed'
    }
    if (publicBotGuardError) {
      body.error = statusCode === 503
        ? '安全验证暂不可用，请稍后重试。'
        : '请先完成安全验证，再提交。'
      body.code = error.code
    }
    reply.code(statusCode).send(body)
  })

  return app
}
