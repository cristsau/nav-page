import { config } from '../config.js'
import { pool } from '../db/index.js'
import { consumePersistentRateLimit } from '../lib/persistentRateLimit.js'
import { deviceKeySite, deviceKeys, deviceKeysAvailable, deviceKeyError } from '../lib/deviceKeys.js'

const password = { type: 'string', minLength: 1, maxLength: 2048 }
const uuid = { type: 'string', format: 'uuid' }
const credential = {
  type: 'object', required: ['id', 'rawId', 'type', 'response'], additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' },
    rawId: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' },
    type: { const: 'public-key' }, response: { type: 'object' }
  }
}

export default async function deviceKeyRoutes(app) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store') })
  app.setErrorHandler((error, request, reply) => {
    const known = /^(DEVICE_KEY_|AUTHENTICATION_REQUIRED)/.test(error.code || '')
    const status = known ? error.statusCode : error.validation || error.code === '23505' ? 400 : 503
    if (!known && !error.validation && error.code !== '23505') request.log.error({ event: 'device_key_unavailable' }, 'Device key operation unavailable')
    reply.code(status).send({ code: known ? error.code : status === 400 ? 'DEVICE_KEY_INVALID' : 'DEVICE_KEY_UNAVAILABLE',
      error: status === 503 ? '快捷登录暂不可用，请使用邮箱或账号密码' : '未能完成验证，请重试或选择其他登录方式' })
  })
  app.get('/auth/device-keys/config', { config: { skipSession: true } }, async request => ({
    enabled: deviceKeysAvailable(request), configured: config.deviceKeysEnabled,
    origin: deviceKeySite(request)?.origin || null, optional: true, label: '快捷登录（通行密钥）'
  }))
  app.get('/auth/device-keys', async (request, reply) => {
    await app.requireAuth(request, reply)
    if (!deviceKeysAvailable(request)) throw deviceKeyError('DEVICE_KEY_UNAVAILABLE', 503)
    return { keys: await deviceKeys.list(request.currentUser.id, request) }
  })

  function post(path, properties, authenticated, handler, required = Object.keys(properties)) {
    app.post(`/auth/device-keys/${path}`, {
      config: { skipSession: !authenticated }, bodyLimit: 32768,
      schema: { body: { type: 'object', properties, required, additionalProperties: false } },
      preValidation: async request => {
        if (!request.body || Object.keys(request.body).some(key => !Object.hasOwn(properties, key))) throw deviceKeyError()
      }
    }, async (request, reply) => {
      if (!deviceKeysAvailable(request)) throw deviceKeyError('DEVICE_KEY_UNAVAILABLE', 503)
      if (authenticated && !request.currentUser) throw deviceKeyError('AUTHENTICATION_REQUIRED', 401)
      const rate = await consumePersistentRateLimit(request.ip, { scope: 'device_key_ip', limit: 30, windowMs: 600000,
        queryFn: pool.query.bind(pool), cleanupEvery: 256 })
      if (!rate.allowed) {
        reply.header('Retry-After', rate.retryAfterSeconds || 60)
        throw deviceKeyError('DEVICE_KEY_RATE_LIMIT', 429)
      }
      return handler(request, reply)
    })
  }
  post('register/options', { currentPassword: password, name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' } }, true,
    (request, reply) => deviceKeys.registerOptions(request, reply, request.body))
  post('register/verify', { challengeId: uuid, response: credential }, true,
    (request, reply) => deviceKeys.registerVerify(request, reply, request.body))
  post('login/options', { trustDevice: { type: 'boolean' } }, false,
    (request, reply) => deviceKeys.loginOptions(request, reply, request.body), [])
  post('login/verify', { challengeId: uuid, response: credential }, false, async (request, reply) => {
    const result = await deviceKeys.loginVerify(request, reply, request.body)
    await app.setSessionCookie(reply, result.token, result.trustDevice)
    return { user: result.user }
  })
  post('remove', { id: uuid, currentPassword: password }, true, async (request, reply) => {
    const result = await deviceKeys.remove(request, request.body)
    if (result.currentSessionRevoked) await app.clearSessionCookie(reply)
    return result
  })
}
