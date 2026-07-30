import { query, withTransaction } from '../db/index.js'
import { mapBookmark, mapGroup } from '../lib/navigation.js'
import { normalizeHttpUrl } from '../lib/urls.js'

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
}

async function requireOwnedGroup(userId, groupId, reply) {
  const result = await query(
    `
      SELECT *
      FROM nav_groups
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [groupId, userId]
  )

  if (!result.rows.length) {
    reply.code(404)
    return null
  }

  return result.rows[0]
}

async function requireOwnedBookmark(userId, bookmarkId, reply) {
  const result = await query(
    `
      SELECT *
      FROM nav_bookmarks
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [bookmarkId, userId]
  )

  if (!result.rows.length) {
    reply.code(404)
    return null
  }

  return result.rows[0]
}

export default async function navigationRoutes(fastify) {
  fastify.get('/groups', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const { rows } = await query(
      `
        SELECT *
        FROM nav_groups
        WHERE user_id = $1
        ORDER BY display_order ASC, created_at ASC
      `,
      [request.currentUser.id]
    )

    return { groups: rows.map(mapGroup) }
  })

  fastify.post('/groups', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const name = normalizeText(request.body?.name)
    if (!name) {
      reply.code(400)
      return { error: 'Group name is required' }
    }

    const icon = normalizeText(request.body?.icon, 'D') || 'D'
    const color = normalizeText(request.body?.color, '#3b82f6') || '#3b82f6'

    const result = await withTransaction(async (client) => {
      const orderResult = await client.query(
        'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM nav_groups WHERE user_id = $1',
        [request.currentUser.id]
      )

      const nextOrder = Number(orderResult.rows[0].next_order || 0)

      return client.query(
        `
          INSERT INTO nav_groups (user_id, name, icon, color, display_order)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `,
        [request.currentUser.id, name, icon, color, nextOrder]
      )
    })

    reply.code(201)
    return { group: mapGroup(result.rows[0]) }
  })

  fastify.put('/groups/:groupId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedGroup(request.currentUser.id, request.params.groupId, reply)
    if (!existing) {
      return { error: 'Group not found' }
    }

    const name = normalizeText(request.body?.name, existing.name) || existing.name
    const icon = normalizeText(request.body?.icon, existing.icon) || existing.icon
    const color = normalizeText(request.body?.color, existing.color) || existing.color
    const collapsed = typeof request.body?.collapsed === 'boolean'
      ? request.body.collapsed
      : existing.collapsed

    const { rows } = await query(
      `
        UPDATE nav_groups
        SET name = $3,
            icon = $4,
            color = $5,
            collapsed = $6,
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
        RETURNING *
      `,
      [request.params.groupId, request.currentUser.id, name, icon, color, collapsed]
    )

    return { group: mapGroup(rows[0]) }
  })

  fastify.delete('/groups/:groupId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedGroup(request.currentUser.id, request.params.groupId, reply)
    if (!existing) {
      return { error: 'Group not found' }
    }

    await query('DELETE FROM nav_groups WHERE id = $1 AND user_id = $2', [
      request.params.groupId,
      request.currentUser.id
    ])

    return { ok: true }
  })

  fastify.post('/groups/reorder', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const ids = Array.isArray(request.body?.ids) ? request.body.ids : []
    await withTransaction(async (client) => {
      for (let index = 0; index < ids.length; index += 1) {
        await client.query(
          `
            UPDATE nav_groups
            SET display_order = $3,
                updated_at = NOW()
            WHERE id = $1
              AND user_id = $2
          `,
          [ids[index], request.currentUser.id, index]
        )
      }
    })

    return { ok: true }
  })

  fastify.get('/bookmarks', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const groupId = normalizeText(request.query?.groupId)
    const params = [request.currentUser.id]
    let whereClause = 'WHERE user_id = $1'

    if (groupId) {
      params.push(groupId)
      whereClause += ' AND group_id = $2'
    }

    const { rows } = await query(
      `
        SELECT *
        FROM nav_bookmarks
        ${whereClause}
        ORDER BY display_order ASC, created_at ASC
      `,
      params
    )

    return { bookmarks: rows.map(mapBookmark) }
  })

  fastify.get('/bookmarks/search', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const search = normalizeText(request.query?.q).toLowerCase()
    if (!search) {
      return { bookmarks: [] }
    }

    const { rows } = await query(
      `
        SELECT *
        FROM nav_bookmarks
        WHERE user_id = $1
          AND (
            LOWER(title) LIKE $2
            OR LOWER(url) LIKE $2
            OR LOWER(description) LIKE $2
          )
        ORDER BY updated_at DESC
      `,
      [request.currentUser.id, `%${search}%`]
    )

    return { bookmarks: rows.map(mapBookmark) }
  })

  fastify.post('/bookmarks', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const groupId = normalizeText(request.body?.groupId)
    const title = normalizeText(request.body?.title)
    const rawUrl = normalizeText(request.body?.url)
    const url = normalizeHttpUrl(rawUrl)

    if (!groupId || !title || !rawUrl) {
      reply.code(400)
      return { error: 'Group, title, and url are required' }
    }

    if (!url) {
      reply.code(400)
      return { error: 'Only valid http and https URLs can be saved' }
    }

    const ownedGroup = await requireOwnedGroup(request.currentUser.id, groupId, reply)
    if (!ownedGroup) {
      return { error: 'Group not found' }
    }

    const favicon = normalizeText(request.body?.favicon)
    const description = normalizeText(request.body?.description)
    const tags = normalizeTags(request.body?.tags)
    const deduplicate = Boolean(request.body?.deduplicate)

    const result = await withTransaction(async (client) => {
      if (deduplicate) {
        const existingResult = await client.query(
          `
            SELECT *
            FROM nav_bookmarks
            WHERE user_id = $1
              AND group_id = $2
              AND LOWER(url) = LOWER($3)
            LIMIT 1
          `,
          [request.currentUser.id, groupId, url]
        )

        if (existingResult.rows.length) {
          return {
            created: false,
            row: existingResult.rows[0]
          }
        }
      }

      const orderResult = await client.query(
        'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM nav_bookmarks WHERE user_id = $1 AND group_id = $2',
        [request.currentUser.id, groupId]
      )

      const nextOrder = Number(orderResult.rows[0].next_order || 0)

      const insertResult = await client.query(
        `
          INSERT INTO nav_bookmarks (
            user_id,
            group_id,
            title,
            url,
            favicon,
            description,
            tags,
            display_order
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          RETURNING *
        `,
        [request.currentUser.id, groupId, title, url, favicon, description, JSON.stringify(tags), nextOrder]
      )

      return {
        created: true,
        row: insertResult.rows[0]
      }
    })

    reply.code(result.created ? 201 : 200)
    return {
      bookmark: mapBookmark(result.row),
      created: result.created
    }
  })

  fastify.put('/bookmarks/:bookmarkId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedBookmark(request.currentUser.id, request.params.bookmarkId, reply)
    if (!existing) {
      return { error: 'Bookmark not found' }
    }

    const groupId = normalizeText(request.body?.groupId, existing.group_id) || existing.group_id
    const title = normalizeText(request.body?.title, existing.title) || existing.title
    const rawUrl = normalizeText(request.body?.url, existing.url) || existing.url
    const url = normalizeHttpUrl(rawUrl)
    const favicon = normalizeText(request.body?.favicon, existing.favicon)
    const description = normalizeText(request.body?.description, existing.description)
    const tags = request.body?.tags === undefined ? existing.tags : normalizeTags(request.body.tags)

    if (!url) {
      reply.code(400)
      return { error: 'Only valid http and https URLs can be saved' }
    }

    const ownedGroup = await requireOwnedGroup(request.currentUser.id, groupId, reply)
    if (!ownedGroup) {
      return { error: 'Group not found' }
    }

    const { rows } = await query(
      `
        UPDATE nav_bookmarks
        SET group_id = $3,
            title = $4,
            url = $5,
            favicon = $6,
            description = $7,
            tags = $8::jsonb,
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
        RETURNING *
      `,
      [request.params.bookmarkId, request.currentUser.id, groupId, title, url, favicon, description, JSON.stringify(tags)]
    )

    return { bookmark: mapBookmark(rows[0]) }
  })

  fastify.delete('/bookmarks/:bookmarkId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedBookmark(request.currentUser.id, request.params.bookmarkId, reply)
    if (!existing) {
      return { error: 'Bookmark not found' }
    }

    await query('DELETE FROM nav_bookmarks WHERE id = $1 AND user_id = $2', [
      request.params.bookmarkId,
      request.currentUser.id
    ])

    return { ok: true }
  })

  fastify.post('/bookmarks/reorder', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const groupId = normalizeText(request.body?.groupId)
    const ids = Array.isArray(request.body?.ids) ? request.body.ids : []

    if (!groupId) {
      reply.code(400)
      return { error: 'Group id is required' }
    }

    await withTransaction(async (client) => {
      for (let index = 0; index < ids.length; index += 1) {
        await client.query(
          `
            UPDATE nav_bookmarks
            SET group_id = $3,
                display_order = $4,
                updated_at = NOW()
            WHERE id = $1
              AND user_id = $2
          `,
          [ids[index], request.currentUser.id, groupId, index]
        )
      }
    })

    return { ok: true }
  })
}
