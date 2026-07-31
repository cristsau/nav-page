import { query } from '../db/index.js'
import {
  isPlainObject,
  mergeAppConfigSecrets,
  redactAppConfigSecrets,
  sanitizeRetiredSearchProviders
} from '../lib/settingsSecrets.js'
import { validateAppConfigModelIds } from '../lib/aiModelSettings.js'

function normalizeKey(value) {
  return String(value || '').trim()
}

export default async function settingsRoutes(fastify) {
  fastify.get('/settings/:key', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const key = normalizeKey(request.params?.key)
    if (!key) {
      reply.code(400)
      return { error: 'Setting key is required' }
    }

    const { rows } = await query(
      `
        SELECT key, value, updated_at
        FROM user_settings
        WHERE user_id = $1
          AND key = $2
        LIMIT 1
      `,
      [request.currentUser.id, key]
    )

    const record = rows[0]

    return {
      key,
      value: key === 'appConfig'
        ? redactAppConfigSecrets(record?.value)
        : record?.value,
      updatedAt: record?.updated_at || null
    }
  })

  fastify.put('/settings/:key', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const key = normalizeKey(request.params?.key)
    if (!key) {
      reply.code(400)
      return { error: 'Setting key is required' }
    }

    const payload = request.body || {}
    const hasRequestedValue = Object.prototype.hasOwnProperty.call(payload, 'value')
    const requestedValue = hasRequestedValue
      ? payload.value
      : null
    let value = requestedValue

    if (key === 'appConfig') {
      if (!hasRequestedValue || !isPlainObject(requestedValue)) {
        reply.code(400)
        return { error: 'appConfig value must be an object' }
      }

      const sanitizedRequestedValue = sanitizeRetiredSearchProviders(requestedValue)

      try {
        validateAppConfigModelIds(sanitizedRequestedValue)
      } catch (error) {
        reply.code(400)
        return { error: error.message || '模型 ID 格式无效' }
      }

      const existing = await query(
        `
          SELECT value
          FROM user_settings
          WHERE user_id = $1
            AND key = $2
          LIMIT 1
        `,
        [request.currentUser.id, key]
      )

      value = mergeAppConfigSecrets(
        sanitizedRequestedValue,
        existing.rows[0]?.value
      )
    }

    const { rows } = await query(
      `
        INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (user_id, key)
        DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = NOW()
        RETURNING key, value, updated_at
      `,
      [request.currentUser.id, key, JSON.stringify(value)]
    )

    return {
      key: rows[0].key,
      value: key === 'appConfig'
        ? redactAppConfigSecrets(rows[0].value)
        : rows[0].value,
      updatedAt: rows[0].updated_at
    }
  })
}
