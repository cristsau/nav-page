import { query } from '../db/index.js'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import { resolveChatProviderModel } from '../lib/aiModelCatalog.js'
import {
  buildBookmarkHealthState,
  consumeBookmarkHealthRateLimit,
  probeBookmarkUrl
} from '../lib/bookmarkHealth.js'
import { buildBookmarkAiTagInput } from '../lib/bookmarkAi.js'
import { normalizeBookmarkUserTags } from '../lib/bookmarkTags.js'
import { mapBookmark, mapGroup } from '../lib/navigation.js'
import { withNavigationTransaction } from '../lib/navigationTransactions.js'
import { runNoteAi, selectNoteAiProvider } from '../lib/noteAi.js'
import { getUserSettingValue } from '../lib/userSettings.js'
import { normalizeHttpUrl } from '../lib/urls.js'
import {
  AI_USAGE_FEATURES
} from '../lib/aiUsage.js'
import { recordRuntimeAiUsageSafely } from '../lib/aiUsageRuntime.js'

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_REORDER_IDS = 500
const MAX_BULK_IDS = 100
const MAX_HEALTH_CHECK_IDS = 20
const MAX_ATOMIC_REORDER_BOOKMARK_IDS = 5_000

export function normalizeNavigationUuid(value) {
  const normalized = normalizeText(value).toLowerCase()
  return UUID_PATTERN.test(normalized) ? normalized : ''
}

export function validateNavigationIdList(value, {
  min = 0,
  max = MAX_REORDER_IDS
} = {}) {
  if (!Array.isArray(value)) {
    return { ok: false, code: 'invalid_ids', ids: [] }
  }
  if (value.length < min || value.length > max) {
    return { ok: false, code: 'invalid_id_count', ids: [] }
  }

  const ids = value.map(normalizeNavigationUuid)
  if (ids.some((id) => !id)) {
    return { ok: false, code: 'invalid_id', ids: [] }
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, code: 'duplicate_ids', ids: [] }
  }

  return { ok: true, code: '', ids }
}

export function haveSameNavigationIds(expected, actual) {
  if (expected.length !== actual.length) return false
  const actualIds = new Set(actual.map((value) => String(value).toLowerCase()))
  return expected.every((value) => actualIds.has(String(value).toLowerCase()))
}

export function validateAtomicNavigationReorderPayload(value) {
  const groupValidation = validateNavigationIdList(value?.groupIds, {
    min: 0,
    max: MAX_REORDER_IDS
  })
  if (!groupValidation.ok) {
    return {
      ok: false,
      code: `group_${groupValidation.code}`,
      groupIds: [],
      bookmarkOrders: []
    }
  }

  if (
    !Array.isArray(value?.bookmarkOrders)
    || value.bookmarkOrders.length > MAX_REORDER_IDS
  ) {
    return {
      ok: false,
      code: 'invalid_bookmark_orders',
      groupIds: [],
      bookmarkOrders: []
    }
  }

  const bookmarkOrders = []
  const bookmarkGroupIds = []
  const seenBookmarkGroupIds = new Set()
  const seenBookmarkIds = new Set()
  let bookmarkIdCount = 0

  for (const entry of value.bookmarkOrders) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        code: 'invalid_bookmark_order',
        groupIds: [],
        bookmarkOrders: []
      }
    }

    const groupId = normalizeNavigationUuid(entry.groupId)
    if (!groupId) {
      return {
        ok: false,
        code: 'invalid_bookmark_group_id',
        groupIds: [],
        bookmarkOrders: []
      }
    }
    if (seenBookmarkGroupIds.has(groupId)) {
      return {
        ok: false,
        code: 'duplicate_bookmark_group_ids',
        groupIds: [],
        bookmarkOrders: []
      }
    }

    const idsValidation = validateNavigationIdList(entry.ids, {
      min: 0,
      max: MAX_ATOMIC_REORDER_BOOKMARK_IDS
    })
    if (!idsValidation.ok) {
      return {
        ok: false,
        code: `bookmark_${idsValidation.code}`,
        groupIds: [],
        bookmarkOrders: []
      }
    }

    bookmarkIdCount += idsValidation.ids.length
    if (bookmarkIdCount > MAX_ATOMIC_REORDER_BOOKMARK_IDS) {
      return {
        ok: false,
        code: 'bookmark_id_count_exceeded',
        groupIds: [],
        bookmarkOrders: []
      }
    }
    for (const id of idsValidation.ids) {
      if (seenBookmarkIds.has(id)) {
        return {
          ok: false,
          code: 'duplicate_bookmark_ids',
          groupIds: [],
          bookmarkOrders: []
        }
      }
      seenBookmarkIds.add(id)
    }

    seenBookmarkGroupIds.add(groupId)
    bookmarkGroupIds.push(groupId)
    bookmarkOrders.push({ groupId, ids: idsValidation.ids })
  }

  if (!haveSameNavigationIds(groupValidation.ids, bookmarkGroupIds)) {
    return {
      ok: false,
      code: 'bookmark_group_set_mismatch',
      groupIds: [],
      bookmarkOrders: []
    }
  }

  return {
    ok: true,
    code: '',
    groupIds: groupValidation.ids,
    bookmarkOrders
  }
}

function invalidIdsReply(reply, validation) {
  reply.code(400)
  return {
    error: 'Invalid navigation id list',
    code: validation.code
  }
}

function staleNavigationReply(reply) {
  reply.code(409)
  return {
    error: 'Navigation data changed; reload and retry',
    code: 'stale_navigation'
  }
}

async function normalizeBookmarkOrders(client, userId, groupIds) {
  const ids = [...new Set(groupIds.filter(Boolean).map(String))]
  if (!ids.length) return

  await client.query(
    `
      WITH ranked AS (
        SELECT
          id,
          (ROW_NUMBER() OVER (
            PARTITION BY group_id
            ORDER BY display_order ASC, created_at ASC, id ASC
          ) - 1)::INTEGER AS next_order
        FROM nav_bookmarks
        WHERE user_id = $1
          AND group_id = ANY($2::uuid[])
      )
      UPDATE nav_bookmarks AS bookmark
      SET display_order = ranked.next_order,
          updated_at = NOW()
      FROM ranked
      WHERE bookmark.id = ranked.id
        AND bookmark.display_order <> ranked.next_order
    `,
    [userId, ids]
  )
}

async function normalizeTargetBookmarkOrder(client, userId, groupId, selectedIds) {
  await client.query(
    `
      WITH ranked AS (
        SELECT
          id,
          (ROW_NUMBER() OVER (
            ORDER BY
              CASE WHEN id = ANY($3::uuid[]) THEN 1 ELSE 0 END ASC,
              CASE WHEN NOT (id = ANY($3::uuid[])) THEN display_order END ASC,
              CASE WHEN id = ANY($3::uuid[]) THEN array_position($3::uuid[], id) END ASC,
              created_at ASC,
              id ASC
          ) - 1)::INTEGER AS next_order
        FROM nav_bookmarks
        WHERE user_id = $1
          AND group_id = $2
      )
      UPDATE nav_bookmarks AS bookmark
      SET display_order = ranked.next_order,
          updated_at = CASE
            WHEN bookmark.display_order <> ranked.next_order THEN NOW()
            ELSE bookmark.updated_at
          END
      FROM ranked
      WHERE bookmark.id = ranked.id
        AND bookmark.display_order <> ranked.next_order
    `,
    [userId, groupId, selectedIds]
  )
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = Array(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  )
  await Promise.all(workers)
  return results
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

    const result = await withNavigationTransaction(request.currentUser.id, async (client) => {
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

    const groupId = normalizeNavigationUuid(request.params.groupId)
    if (!groupId) {
      reply.code(400)
      return { error: 'Valid group id is required', code: 'invalid_group_id' }
    }

    const deleted = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const result = await client.query(
        `
          DELETE FROM nav_groups
          WHERE id = $1
            AND user_id = $2
          RETURNING id
        `,
        [groupId, request.currentUser.id]
      )
      return result.rows.length > 0
    })

    if (!deleted) {
      reply.code(404)
      return { error: 'Group not found' }
    }

    return { ok: true }
  })

  fastify.post('/groups/reorder', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const validation = validateNavigationIdList(request.body?.ids)
    if (!validation.ok) {
      return invalidIdsReply(reply, validation)
    }

    const reordered = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const current = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE user_id = $1
          ORDER BY display_order ASC, created_at ASC, id ASC
          FOR UPDATE
        `,
        [request.currentUser.id]
      )

      if (!haveSameNavigationIds(validation.ids, current.rows.map(({ id }) => id))) {
        return false
      }

      if (validation.ids.length) {
        await client.query(
          `
            WITH ordered AS (
              SELECT id, ordinality
              FROM unnest($2::uuid[]) WITH ORDINALITY AS input(id, ordinality)
            )
            UPDATE nav_groups AS nav_group
            SET display_order = (ordered.ordinality - 1)::INTEGER,
                updated_at = NOW()
            FROM ordered
            WHERE nav_group.id = ordered.id
              AND nav_group.user_id = $1
          `,
          [request.currentUser.id, validation.ids]
        )
      }

      return true
    })

    if (!reordered) {
      return staleNavigationReply(reply)
    }

    return { ok: true }
  })

  fastify.post('/navigation/reorder', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const validation = validateAtomicNavigationReorderPayload(request.body)
    if (!validation.ok) {
      reply.code(400)
      return {
        error: 'Invalid atomic navigation reorder payload',
        code: validation.code
      }
    }

    const reordered = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const currentGroups = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE user_id = $1
          ORDER BY display_order ASC, created_at ASC, id ASC
          FOR UPDATE
        `,
        [request.currentUser.id]
      )
      if (!haveSameNavigationIds(
        validation.groupIds,
        currentGroups.rows.map(({ id }) => id)
      )) {
        return false
      }

      const currentBookmarks = await client.query(
        `
          SELECT id, group_id
          FROM nav_bookmarks
          WHERE user_id = $1
          ORDER BY group_id ASC, display_order ASC, created_at ASC, id ASC
          FOR UPDATE
        `,
        [request.currentUser.id]
      )
      const currentIdsByGroup = new Map(
        validation.groupIds.map((groupId) => [groupId, []])
      )
      for (const { id, group_id: groupIdValue } of currentBookmarks.rows) {
        const groupId = String(groupIdValue).toLowerCase()
        if (!currentIdsByGroup.has(groupId)) return false
        currentIdsByGroup.get(groupId).push(id)
      }
      for (const order of validation.bookmarkOrders) {
        if (!haveSameNavigationIds(order.ids, currentIdsByGroup.get(order.groupId) || [])) {
          return false
        }
      }

      if (validation.groupIds.length) {
        await client.query(
          `
            WITH ordered AS (
              SELECT id, ordinality
              FROM unnest($2::uuid[]) WITH ORDINALITY AS input(id, ordinality)
            )
            UPDATE nav_groups AS nav_group
            SET display_order = (ordered.ordinality - 1)::INTEGER,
                updated_at = NOW()
            FROM ordered
            WHERE nav_group.id = ordered.id
              AND nav_group.user_id = $1
          `,
          [request.currentUser.id, validation.groupIds]
        )
      }

      for (const order of validation.bookmarkOrders) {
        if (!order.ids.length) continue
        await client.query(
          `
            WITH ordered AS (
              SELECT id, ordinality
              FROM unnest($3::uuid[]) WITH ORDINALITY AS input(id, ordinality)
            )
            UPDATE nav_bookmarks AS bookmark
            SET display_order = (ordered.ordinality - 1)::INTEGER,
                updated_at = NOW()
            FROM ordered
            WHERE bookmark.id = ordered.id
              AND bookmark.user_id = $1
              AND bookmark.group_id = $2
          `,
          [request.currentUser.id, order.groupId, order.ids]
        )
      }

      return true
    })

    if (!reordered) {
      return staleNavigationReply(reply)
    }

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
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(tags) = 'array' THEN tags
                  ELSE '[]'::jsonb
                END
              ) AS tag
              WHERE LOWER(tag) LIKE $2
            )
        )
        ORDER BY updated_at DESC
        LIMIT 50
      `,
      [request.currentUser.id, `%${search}%`]
    )

    return { bookmarks: rows.map(mapBookmark) }
  })

  fastify.post('/bookmarks/health-check', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const healthRateLimit = consumeBookmarkHealthRateLimit(request.currentUser.id)
    if (!healthRateLimit.allowed) {
      reply.header('Retry-After', String(healthRateLimit.retryAfterSeconds))
      reply.code(429)
      return {
        error: 'Link checks are temporarily rate limited',
        code: 'health_check_rate_limited'
      }
    }

    const validation = validateNavigationIdList(request.body?.ids, {
      min: 1,
      max: MAX_HEALTH_CHECK_IDS
    })
    if (!validation.ok) {
      return invalidIdsReply(reply, validation)
    }

    const existing = await query(
      `
        SELECT *
        FROM nav_bookmarks
        WHERE user_id = $1
          AND id = ANY($2::uuid[])
      `,
      [request.currentUser.id, validation.ids]
    )

    if (!haveSameNavigationIds(validation.ids, existing.rows.map(({ id }) => id))) {
      return staleNavigationReply(reply)
    }

    const existingById = new Map(
      existing.rows.map((bookmark) => [String(bookmark.id).toLowerCase(), bookmark])
    )
    const orderedBookmarks = validation.ids.map((id) => existingById.get(id))

    const probeResults = await mapWithConcurrency(
      orderedBookmarks,
      4,
      async (bookmark) => ({
        bookmark,
        probe: await probeBookmarkUrl(bookmark.url)
      })
    )

    // Network probes finish before this short transaction starts. The user-level
    // navigation lock serializes concurrent result writers, while FOR UPDATE
    // re-reads the latest failure count and protects the URL comparison.
    await withNavigationTransaction(request.currentUser.id, async (client) => {
      for (const { bookmark, probe } of probeResults) {
        const currentResult = await client.query(
          `
            SELECT url, health_failure_count
            FROM nav_bookmarks
            WHERE id = $1
              AND user_id = $2
            FOR UPDATE
          `,
          [bookmark.id, request.currentUser.id]
        )
        const current = currentResult.rows[0]
        if (!current || current.url !== bookmark.url) continue

        const health = buildBookmarkHealthState(
          probe,
          current.health_failure_count
        )
        await client.query(
          `
            UPDATE nav_bookmarks
            SET health_status = $4,
                health_http_status = $5,
                health_checked_at = NOW(),
                health_failure_count = $6,
                health_error_code = $7
            WHERE id = $1
              AND user_id = $2
              AND url = $3
          `,
          [
            bookmark.id,
            request.currentUser.id,
            bookmark.url,
            health.healthStatus,
            health.healthHttpStatus,
            health.healthFailureCount,
            health.healthErrorCode
          ]
        )
      }
    })

    const refreshed = await query(
      `
        SELECT *
        FROM nav_bookmarks
        WHERE user_id = $1
          AND id = ANY($2::uuid[])
      `,
      [request.currentUser.id, validation.ids]
    )
    const refreshedById = new Map(
      refreshed.rows.map((bookmark) => [String(bookmark.id).toLowerCase(), bookmark])
    )

    return {
      bookmarks: validation.ids
        .map((id) => refreshedById.get(id))
        .filter(Boolean)
        .map(mapBookmark)
    }
  })

  fastify.post('/bookmarks/bulk/move', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const validation = validateNavigationIdList(request.body?.ids, {
      min: 1,
      max: MAX_BULK_IDS
    })
    if (!validation.ok) {
      return invalidIdsReply(reply, validation)
    }

    const targetGroupId = normalizeNavigationUuid(request.body?.targetGroupId)
    if (!targetGroupId) {
      reply.code(400)
      return { error: 'Valid target group id is required', code: 'invalid_group_id' }
    }

    const moved = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const selected = await client.query(
        `
          SELECT id, group_id
          FROM nav_bookmarks
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, validation.ids]
      )
      if (!haveSameNavigationIds(validation.ids, selected.rows.map(({ id }) => id))) {
        return null
      }

      const sourceGroupIds = selected.rows
        .map(({ group_id: groupId }) => String(groupId))
        .filter((groupId) => groupId !== targetGroupId)
      const affectedGroupIds = [...new Set([...sourceGroupIds, targetGroupId])].sort()
      const ownedGroups = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, affectedGroupIds]
      )
      if (!haveSameNavigationIds(affectedGroupIds, ownedGroups.rows.map(({ id }) => id))) {
        return null
      }

      // Serialize order changes across every affected source and target row.
      await client.query(
        `
          SELECT id
          FROM nav_bookmarks
          WHERE user_id = $1
            AND group_id = ANY($2::uuid[])
          ORDER BY group_id ASC, id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, affectedGroupIds]
      )

      await client.query(
        `
          UPDATE nav_bookmarks
          SET group_id = $3,
              updated_at = NOW()
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
        `,
        [request.currentUser.id, validation.ids, targetGroupId]
      )

      await normalizeBookmarkOrders(client, request.currentUser.id, sourceGroupIds)
      await normalizeTargetBookmarkOrder(
        client,
        request.currentUser.id,
        targetGroupId,
        validation.ids
      )

      return client.query(
        `
          SELECT *
          FROM nav_bookmarks
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          ORDER BY array_position($2::uuid[], id)
        `,
        [request.currentUser.id, validation.ids]
      )
    })

    if (!moved) {
      return staleNavigationReply(reply)
    }

    return { bookmarks: moved.rows.map(mapBookmark) }
  })

  fastify.post('/bookmarks/bulk/delete', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const validation = validateNavigationIdList(request.body?.ids, {
      min: 1,
      max: MAX_BULK_IDS
    })
    if (!validation.ok) {
      return invalidIdsReply(reply, validation)
    }

    const deleted = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const selected = await client.query(
        `
          SELECT id, group_id
          FROM nav_bookmarks
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, validation.ids]
      )
      if (!haveSameNavigationIds(validation.ids, selected.rows.map(({ id }) => id))) {
        return null
      }

      const affectedGroupIds = [
        ...new Set(selected.rows.map(({ group_id: groupId }) => String(groupId)))
      ].sort()
      const ownedGroups = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, affectedGroupIds]
      )
      if (!haveSameNavigationIds(affectedGroupIds, ownedGroups.rows.map(({ id }) => id))) {
        return null
      }

      await client.query(
        `
          SELECT id
          FROM nav_bookmarks
          WHERE user_id = $1
            AND group_id = ANY($2::uuid[])
          ORDER BY group_id ASC, id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, affectedGroupIds]
      )

      const result = await client.query(
        `
          DELETE FROM nav_bookmarks
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          RETURNING id
        `,
        [request.currentUser.id, validation.ids]
      )

      await normalizeBookmarkOrders(
        client,
        request.currentUser.id,
        affectedGroupIds
      )

      return result.rows.length
    })

    if (deleted === null) {
      return staleNavigationReply(reply)
    }

    return { ok: true, deletedCount: deleted }
  })

  fastify.post('/bookmarks/:bookmarkId/ai/tags', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const bookmark = await requireOwnedBookmark(
      request.currentUser.id,
      request.params.bookmarkId,
      reply
    )
    if (!bookmark) {
      return { error: 'Bookmark not found' }
    }

    const rateLimited = await enforceAiRateLimit(request, reply)
    if (rateLimited) return rateLimited

    const appConfig = await getUserSettingValue(
      request.currentUser.id,
      'appConfig',
      {}
    )

    const startedAt = Date.now()
    let provider = null
    try {
      const resolution = await resolveChatProviderModel(
        appConfig?.search?.providers?.chatgpt || {}
      )
      provider = selectNoteAiProvider({
        chatgpt: resolution.provider
      })

      if (!provider) {
        await recordRuntimeAiUsageSafely({
          userId: request.currentUser.id,
          feature: AI_USAGE_FEATURES.BOOKMARK_TAGS,
          provider: 'chatgpt',
          model: 'unknown',
          apiMode: 'unknown',
          success: false,
          usage: null,
          latencyMs: Math.max(0, Date.now() - startedAt)
        }, request.log)
        reply.code(503)
        return { error: '请先在设置中启用 ChatGPT / OpenAI，再生成书签标签' }
      }

      const result = await runNoteAi(
          provider,
          buildBookmarkAiTagInput(bookmark),
          request.currentUser.id
        )
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.BOOKMARK_TAGS,
        provider: result.provider,
        model: result.model,
        apiMode: result.apiMode,
        success: true,
        usage: result.usage,
        latencyMs: result.latencyMs
      }, request.log)
      const {
        usage: _usage,
        apiMode: _apiMode,
        latencyMs: _latencyMs,
        ...publicResult
      } = result
      return {
        result: publicResult
      }
    } catch (error) {
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.BOOKMARK_TAGS,
        provider: provider?.id || 'chatgpt',
        model: provider?.config?.model || 'unknown',
        apiMode: provider?.config?.apiMode || 'unknown',
        success: false,
        usage: null,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }, request.log)
      reply.code(502)
      return {
        error: error.message || '书签智能标签生成失败'
      }
    }
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
    const tags = normalizeBookmarkUserTags(request.body?.tags)
    const deduplicate = Boolean(request.body?.deduplicate)

    const result = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const currentGroup = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [groupId, request.currentUser.id]
      )
      if (!currentGroup.rows.length) return { missing: 'group' }

      if (deduplicate) {
        const existingResult = await client.query(
          `
            SELECT *
            FROM nav_bookmarks
            WHERE user_id = $1
              AND group_id = $2
              AND url = $3
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

    if (result.missing === 'group') {
      reply.code(404)
      return { error: 'Group not found' }
    }

    reply.code(result.created ? 201 : 200)
    return {
      bookmark: mapBookmark(result.row),
      created: result.created
    }
  })

  fastify.put('/bookmarks/:bookmarkId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const bookmarkId = normalizeNavigationUuid(request.params.bookmarkId)
    if (!bookmarkId) {
      reply.code(400)
      return { error: 'Valid bookmark id is required', code: 'invalid_bookmark_id' }
    }

    const existing = await requireOwnedBookmark(request.currentUser.id, bookmarkId, reply)
    if (!existing) {
      return { error: 'Bookmark not found' }
    }

    const groupId = normalizeNavigationUuid(
      normalizeText(request.body?.groupId, existing.group_id) || existing.group_id
    )
    const title = normalizeText(request.body?.title, existing.title) || existing.title
    const rawUrl = normalizeText(request.body?.url, existing.url) || existing.url
    const url = normalizeHttpUrl(rawUrl)
    const favicon = normalizeText(request.body?.favicon, existing.favicon)
    const description = normalizeText(request.body?.description, existing.description)
    const tags = request.body?.tags === undefined
      ? existing.tags
      : normalizeBookmarkUserTags(request.body.tags)

    if (!groupId) {
      reply.code(400)
      return { error: 'Valid group id is required', code: 'invalid_group_id' }
    }
    if (!url) {
      reply.code(400)
      return { error: 'Only valid http and https URLs can be saved' }
    }

    const outcome = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const lockedBookmark = await client.query(
        `
          SELECT *
          FROM nav_bookmarks
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [bookmarkId, request.currentUser.id]
      )
      if (!lockedBookmark.rows.length) return { missing: 'bookmark' }

      const current = lockedBookmark.rows[0]
      const sourceGroupId = String(current.group_id)
      const affectedGroupIds = [...new Set([sourceGroupId, groupId])].sort()
      const ownedGroups = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE user_id = $1
            AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, affectedGroupIds]
      )
      if (!haveSameNavigationIds(affectedGroupIds, ownedGroups.rows.map(({ id }) => id))) {
        return { missing: 'group' }
      }

      const moved = sourceGroupId !== groupId
      if (moved) {
        await client.query(
          `
            SELECT id
            FROM nav_bookmarks
            WHERE user_id = $1
              AND group_id = ANY($2::uuid[])
            ORDER BY group_id ASC, id ASC
            FOR UPDATE
          `,
          [request.currentUser.id, affectedGroupIds]
        )
      }

      const urlChanged = url !== current.url
      await client.query(
        `
          UPDATE nav_bookmarks
          SET group_id = $3,
              title = $4,
              url = $5,
              favicon = $6,
              description = $7,
              tags = $8::jsonb,
              health_status = CASE WHEN $9 THEN 'unchecked' ELSE health_status END,
              health_http_status = CASE WHEN $9 THEN NULL ELSE health_http_status END,
              health_checked_at = CASE WHEN $9 THEN NULL ELSE health_checked_at END,
              health_failure_count = CASE WHEN $9 THEN 0 ELSE health_failure_count END,
              health_error_code = CASE WHEN $9 THEN NULL ELSE health_error_code END,
              updated_at = NOW()
          WHERE id = $1
            AND user_id = $2
        `,
        [
          bookmarkId,
          request.currentUser.id,
          groupId,
          title,
          url,
          favicon,
          description,
          JSON.stringify(tags),
          urlChanged
        ]
      )

      if (moved) {
        await normalizeBookmarkOrders(
          client,
          request.currentUser.id,
          [sourceGroupId]
        )
        await normalizeTargetBookmarkOrder(
          client,
          request.currentUser.id,
          groupId,
          [bookmarkId]
        )
      }

      const refreshed = await client.query(
        `
          SELECT *
          FROM nav_bookmarks
          WHERE id = $1
            AND user_id = $2
        `,
        [bookmarkId, request.currentUser.id]
      )
      return { bookmark: refreshed.rows[0] }
    })

    if (outcome.missing === 'bookmark') {
      reply.code(404)
      return { error: 'Bookmark not found' }
    }
    if (outcome.missing === 'group') {
      reply.code(404)
      return { error: 'Group not found' }
    }

    return { bookmark: mapBookmark(outcome.bookmark) }
  })

  fastify.delete('/bookmarks/:bookmarkId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const bookmarkId = normalizeNavigationUuid(request.params.bookmarkId)
    if (!bookmarkId) {
      reply.code(400)
      return { error: 'Valid bookmark id is required', code: 'invalid_bookmark_id' }
    }

    const deleted = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const locked = await client.query(
        `
          SELECT id, group_id
          FROM nav_bookmarks
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [bookmarkId, request.currentUser.id]
      )
      if (!locked.rows.length) return false

      const groupId = String(locked.rows[0].group_id)
      await client.query(
        `
          SELECT id
          FROM nav_bookmarks
          WHERE user_id = $1
            AND group_id = $2
          ORDER BY id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, groupId]
      )
      await client.query(
        `
          DELETE FROM nav_bookmarks
          WHERE id = $1
            AND user_id = $2
        `,
        [bookmarkId, request.currentUser.id]
      )
      await normalizeBookmarkOrders(client, request.currentUser.id, [groupId])
      return true
    })

    if (!deleted) {
      reply.code(404)
      return { error: 'Bookmark not found' }
    }

    return { ok: true }
  })

  fastify.post('/bookmarks/reorder', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const groupId = normalizeNavigationUuid(request.body?.groupId)
    const validation = validateNavigationIdList(request.body?.ids)

    if (!groupId) {
      reply.code(400)
      return { error: 'Valid group id is required', code: 'invalid_group_id' }
    }
    if (!validation.ok) {
      return invalidIdsReply(reply, validation)
    }

    const reordered = await withNavigationTransaction(request.currentUser.id, async (client) => {
      const group = await client.query(
        `
          SELECT id
          FROM nav_groups
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [groupId, request.currentUser.id]
      )
      if (!group.rows.length) return false

      const current = await client.query(
        `
          SELECT id
          FROM nav_bookmarks
          WHERE user_id = $1
            AND group_id = $2
          ORDER BY display_order ASC, created_at ASC, id ASC
          FOR UPDATE
        `,
        [request.currentUser.id, groupId]
      )
      if (!haveSameNavigationIds(validation.ids, current.rows.map(({ id }) => id))) {
        return false
      }

      if (validation.ids.length) {
        await client.query(
          `
            WITH ordered AS (
              SELECT id, ordinality
              FROM unnest($3::uuid[]) WITH ORDINALITY AS input(id, ordinality)
            )
            UPDATE nav_bookmarks AS bookmark
            SET display_order = (ordered.ordinality - 1)::INTEGER,
                updated_at = NOW()
            FROM ordered
            WHERE bookmark.id = ordered.id
              AND bookmark.user_id = $1
              AND bookmark.group_id = $2
          `,
          [request.currentUser.id, groupId, validation.ids]
        )
      }

      return true
    })

    if (!reordered) {
      return staleNavigationReply(reply)
    }

    return { ok: true }
  })
}
