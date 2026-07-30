import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { config } from './config.js'
import {
  createCorsOriginValidator,
  isUnsafeRequestOriginTrusted
} from './lib/requestSecurity.js'
import authPlugin from './plugins/auth.js'
import adminTelegramRoutes from './routes/adminTelegram.js'
import aiSearchRoutes from './routes/aiSearch.js'
import authRoutes from './routes/auth.js'
import customSearchEngineRoutes from './routes/customSearchEngines.js'
import migrationRoutes from './routes/migration.js'
import navigationRoutes from './routes/navigation.js'
import noteAiRoutes from './routes/noteAi.js'
import notesRoutes from './routes/notes.js'
import settingsRoutes from './routes/settings.js'

export function createApp() {
  const app = Fastify({
    logger: true
  })

  app.register(cookie)
  app.register(cors, {
    origin: createCorsOriginValidator(config.corsOrigin),
    credentials: true
  })

  app.register(authPlugin)

  app.addHook('onRequest', async (request, reply) => {
    if (!isUnsafeRequestOriginTrusted(request, config.corsOrigin)) {
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

  app.register(adminTelegramRoutes, { prefix: '/api' })
  app.register(aiSearchRoutes, { prefix: '/api' })
  app.register(authRoutes, { prefix: '/api' })
  app.register(customSearchEngineRoutes, { prefix: '/api' })
  app.register(migrationRoutes, { prefix: '/api' })
  app.register(navigationRoutes, { prefix: '/api' })
  app.register(noteAiRoutes, { prefix: '/api' })
  app.register(notesRoutes, { prefix: '/api' })
  app.register(settingsRoutes, { prefix: '/api' })

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

    reply.code(statusCode).send({
      error: error.message || 'Internal Server Error'
    })
  })

  return app
}
