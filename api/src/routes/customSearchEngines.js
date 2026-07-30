import { query, withTransaction } from '../db/index.js'
import {
  isValidSearchUrl,
  mapCustomSearchEngine,
  normalizeEngineMonogram,
  removeSearchEngineReferences
} from '../lib/searchEngines.js'

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

export default async function customSearchEngineRoutes(fastify) {
  fastify.get('/search-engines/custom', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const { rows } = await query(
      `
        SELECT *
        FROM custom_search_engines
        WHERE user_id = $1
        ORDER BY display_order ASC, created_at ASC
      `,
      [request.currentUser.id]
    )

    return { engines: rows.map(mapCustomSearchEngine) }
  })

  fastify.post('/search-engines/custom', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const name = normalizeText(request.body?.name)
    const url = normalizeText(request.body?.url)
    const icon = normalizeEngineMonogram(request.body?.icon)

    if (!name || !url) {
      reply.code(400)
      return { error: 'Name and url are required' }
    }

    if (!isValidSearchUrl(url)) {
      reply.code(400)
      return { error: 'Search url must use http or https' }
    }

    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(
        'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM custom_search_engines WHERE user_id = $1',
        [request.currentUser.id]
      )
      const nextOrder = Number(orderResult.rows[0].next_order || 0)

      return client.query(
        `
          INSERT INTO custom_search_engines (user_id, name, icon, url, display_order)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `,
        [request.currentUser.id, name, icon, url, nextOrder]
      )
    })

    reply.code(201)
    return { engine: mapCustomSearchEngine(result.rows[0]) }
  })

  fastify.put('/search-engines/custom/:engineId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await query(
      'SELECT * FROM custom_search_engines WHERE id = $1 AND user_id = $2 LIMIT 1',
      [request.params.engineId, request.currentUser.id]
    )

    if (!existing.rows.length) {
      reply.code(404)
      return { error: 'Engine not found' }
    }

    const row = existing.rows[0]
    const name = normalizeText(request.body?.name, row.name) || row.name
    const url = normalizeText(request.body?.url, row.url) || row.url
    const icon = request.body?.icon === undefined
      ? normalizeEngineMonogram(row.icon)
      : normalizeEngineMonogram(request.body.icon)

    if (!isValidSearchUrl(url)) {
      reply.code(400)
      return { error: 'Search url must use http or https' }
    }

    const { rows } = await query(
      `
        UPDATE custom_search_engines
        SET name = $3,
            icon = $4,
            url = $5,
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
        RETURNING *
      `,
      [request.params.engineId, request.currentUser.id, name, icon, url]
    )

    return { engine: mapCustomSearchEngine(rows[0]) }
  })

  fastify.delete('/search-engines/custom/:engineId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const result = await withTransaction(async (client) => {
      const deleted = await client.query(
        'DELETE FROM custom_search_engines WHERE id = $1 AND user_id = $2 RETURNING id',
        [request.params.engineId, request.currentUser.id]
      )

      if (!deleted.rows.length) {
        return deleted
      }

      const setting = await client.query(
        `
          SELECT value
          FROM user_settings
          WHERE user_id = $1
            AND key = 'appConfig'
          FOR UPDATE
        `,
        [request.currentUser.id]
      )

      if (setting.rows.length) {
        const updatedConfig = removeSearchEngineReferences(
          setting.rows[0].value,
          request.params.engineId
        )

        await client.query(
          `
            UPDATE user_settings
            SET value = $2::jsonb,
                updated_at = NOW()
            WHERE user_id = $1
              AND key = 'appConfig'
          `,
          [request.currentUser.id, JSON.stringify(updatedConfig)]
        )
      }

      return deleted
    })

    if (!result.rows.length) {
      reply.code(404)
      return { error: 'Engine not found' }
    }

    return { ok: true }
  })
}
