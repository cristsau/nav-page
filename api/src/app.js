import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { config, isProduction } from './config.js'
import authPlugin from './plugins/auth.js'
import adminTelegramRoutes from './routes/adminTelegram.js'
import aiSearchRoutes from './routes/aiSearch.js'
import authRoutes from './routes/auth.js'
import customSearchEngineRoutes from './routes/customSearchEngines.js'
import migrationRoutes from './routes/migration.js'
import navigationRoutes from './routes/navigation.js'
import notesRoutes from './routes/notes.js'
import settingsRoutes from './routes/settings.js'

export function createApp() {
  const app = Fastify({
    logger: true
  })

  app.register(cookie)
  app.register(cors, {
    origin: isProduction() ? true : config.corsOrigin,
    credentials: true
  })

  app.register(authPlugin)

  app.get('/health', async () => ({
    ok: true,
    service: 'nav-api'
  }))

  app.register(adminTelegramRoutes, { prefix: '/api' })
  app.register(aiSearchRoutes, { prefix: '/api' })
  app.register(authRoutes, { prefix: '/api' })
  app.register(customSearchEngineRoutes, { prefix: '/api' })
  app.register(migrationRoutes, { prefix: '/api' })
  app.register(navigationRoutes, { prefix: '/api' })
  app.register(notesRoutes, { prefix: '/api' })
  app.register(settingsRoutes, { prefix: '/api' })

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error)

    if (reply.statusCode < 400) {
      reply.code(500)
    }

    reply.send({
      error: error.message || 'Internal Server Error'
    })
  })

  return app
}
