import { query, withTransaction } from '../db/index.js'
import { mapCustomSearchEngine } from '../lib/searchEngines.js'

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
    const icon = normalizeText(request.body?.icon, '🔍') || '🔍'

    if (!name || !url) {
      reply.code(400)
      return { error: 'Name and url are required' }
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
    const icon = normalizeText(request.body?.icon, row.icon) || row.icon

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

    const result = await query(
      'DELETE FROM custom_search_engines WHERE id = $1 AND user_id = $2 RETURNING id',
      [request.params.engineId, request.currentUser.id]
    )

    if (!result.rows.length) {
      reply.code(404)
      return { error: 'Engine not found' }
    }

    return { ok: true }
  })
}
