import { query, withTransaction } from '../db/index.js'
import {
  WorkspaceDatabaseError,
  applyWorkspaceDatabaseView,
  assertWorkspaceDatabaseRelationTargets,
  mapWorkspaceDatabase,
  mapWorkspaceDatabaseProperty,
  mapWorkspaceDatabaseRow,
  mapWorkspaceDatabaseView,
  normalizeWorkspaceDatabaseDescription,
  normalizeWorkspaceDatabaseIcon,
  normalizeWorkspaceDatabaseIdentity,
  normalizeWorkspaceDatabaseName,
  normalizeWorkspaceDatabaseProperties,
  normalizeWorkspaceDatabasePropertyConfig,
  normalizeWorkspaceDatabaseRowTitle,
  normalizeWorkspaceDatabaseRowValues,
  normalizeWorkspaceDatabaseViewConfig,
  normalizeWorkspaceDatabaseViewType,
  syncWorkspaceDatabaseRelations
} from '../lib/workspaceDatabases.js'

function sendWorkspaceDatabaseError(reply, error) {
  if (!(error instanceof WorkspaceDatabaseError)) throw error
  reply.code(error.statusCode)
  return {
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {})
  }
}

async function requireDatabase(client, userId, databaseId, { lock = false } = {}) {
  const id = normalizeWorkspaceDatabaseIdentity(databaseId)
  const result = await client.query(
    `
      SELECT *
      FROM workspace_databases
      WHERE id = $1 AND user_id = $2
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [id, userId]
  )
  if (!result.rows.length) {
    throw new WorkspaceDatabaseError('数据库不存在', {
      code: 'workspace_database_not_found',
      statusCode: 404
    })
  }
  return result.rows[0]
}

async function loadProperties(client, userId, databaseId) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM workspace_database_properties
      WHERE database_id = $1 AND user_id = $2
      ORDER BY display_order ASC, created_at ASC, id ASC
    `,
    [databaseId, userId]
  )
  return rows.map(mapWorkspaceDatabaseProperty)
}

async function loadViews(client, userId, databaseId) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM workspace_database_views
      WHERE database_id = $1 AND user_id = $2
      ORDER BY display_order ASC, created_at ASC, id ASC
    `,
    [databaseId, userId]
  )
  return rows.map(mapWorkspaceDatabaseView)
}

async function requireProperty(client, userId, databaseId, propertyId, { lock = false } = {}) {
  const id = normalizeWorkspaceDatabaseIdentity(propertyId, '属性 ID')
  const { rows } = await client.query(
    `
      SELECT *
      FROM workspace_database_properties
      WHERE id = $1 AND database_id = $2 AND user_id = $3
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [id, databaseId, userId]
  )
  if (!rows.length) {
    throw new WorkspaceDatabaseError('属性不存在', {
      code: 'workspace_database_property_not_found',
      statusCode: 404
    })
  }
  return rows[0]
}

async function requireView(client, userId, databaseId, viewId, { lock = false } = {}) {
  const id = normalizeWorkspaceDatabaseIdentity(viewId, '视图 ID')
  const { rows } = await client.query(
    `
      SELECT *
      FROM workspace_database_views
      WHERE id = $1 AND database_id = $2 AND user_id = $3
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [id, databaseId, userId]
  )
  if (!rows.length) {
    throw new WorkspaceDatabaseError('视图不存在', {
      code: 'workspace_database_view_not_found',
      statusCode: 404
    })
  }
  return rows[0]
}

async function requireRow(client, userId, databaseId, rowId, { lock = false } = {}) {
  const id = normalizeWorkspaceDatabaseIdentity(rowId, '记录 ID')
  const { rows } = await client.query(
    `
      SELECT *
      FROM workspace_database_rows
      WHERE id = $1 AND database_id = $2 AND user_id = $3
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [id, databaseId, userId]
  )
  if (!rows.length) {
    throw new WorkspaceDatabaseError('记录不存在', {
      code: 'workspace_database_row_not_found',
      statusCode: 404
    })
  }
  return rows[0]
}

async function assertPropertyConfigCompatible(client, userId, databaseId, property, nextConfig) {
  if (['select', 'multi_select', 'status'].includes(property.type)) {
    const nextIds = new Set((nextConfig.options || []).map((option) => option.id))
    const removedIds = (property.config?.options || [])
      .map((option) => option.id)
      .filter((id) => !nextIds.has(id))
    if (removedIds.length) {
      const expression = property.type === 'multi_select'
        ? '(values -> $3) ?| $4::text[]'
        : 'values ->> $3 = ANY($4::text[])'
      const used = await client.query(
        `
          SELECT 1
          FROM workspace_database_rows
          WHERE database_id = $1 AND user_id = $2
            AND ${expression}
          LIMIT 1
        `,
        [databaseId, userId, property.id, removedIds]
      )
      if (used.rows.length) {
        throw new WorkspaceDatabaseError('仍有记录使用即将删除的选项，请先迁移这些记录', {
          code: 'workspace_database_property_option_in_use',
          statusCode: 409
        })
      }
    }
  }
  if (property.type === 'relation'
      && nextConfig.targetDatabaseId !== property.config?.targetDatabaseId) {
    const used = await client.query(
      `
        SELECT 1
        FROM workspace_database_rows
        WHERE database_id = $1 AND user_id = $2
          AND jsonb_typeof(values -> $3) = 'array'
          AND jsonb_array_length(values -> $3) > 0
        LIMIT 1
      `,
      [databaseId, userId, property.id]
    )
    if (used.rows.length) {
      throw new WorkspaceDatabaseError('关联属性已有数据，不能直接更换目标数据库', {
        code: 'workspace_database_relation_target_in_use',
        statusCode: 409
      })
    }
  }
}

async function repairViewsAfterPropertyDeletion(client, userId, databaseId, deletedPropertyId) {
  const properties = await loadProperties(client, userId, databaseId)
  const fallbackPropertyId = properties.find((property) => property.type === 'title')?.id
    || properties[0]?.id
  const views = await loadViews(client, userId, databaseId)
  for (const view of views) {
    const config = view.config || {}
    const visiblePropertyIds = (config.visiblePropertyIds || [])
      .filter((id) => id !== deletedPropertyId)
    const normalized = normalizeWorkspaceDatabaseViewConfig({
      filters: (config.filters || []).filter((filter) => filter.propertyId !== deletedPropertyId),
      sorts: (config.sorts || []).filter((sort) => sort.propertyId !== deletedPropertyId),
      visiblePropertyIds: visiblePropertyIds.length
        ? visiblePropertyIds
        : [fallbackPropertyId],
      groupByPropertyId: config.groupByPropertyId === deletedPropertyId
        ? null
        : (config.groupByPropertyId || null)
    }, properties)
    await client.query(
      `
        UPDATE workspace_database_views
        SET config = $4::jsonb, updated_at = NOW()
        WHERE id = $1 AND database_id = $2 AND user_id = $3
      `,
      [view.id, databaseId, userId, JSON.stringify(normalized)]
    )
  }
}

async function loadBacklinks(userId, rowIds) {
  if (!rowIds.length) return {}
  const { rows } = await query(
    `
      SELECT
        relation.target_row_id,
        relation.source_property_id,
        source_row.id AS source_row_id,
        source_row.title AS source_row_title,
        source_row.database_id AS source_database_id,
        source_database.name AS source_database_name,
        source_property.name AS source_property_name
      FROM workspace_database_relations AS relation
      JOIN workspace_database_rows AS source_row
        ON source_row.id = relation.source_row_id
       AND source_row.database_id = relation.source_database_id
       AND source_row.user_id = relation.user_id
      JOIN workspace_databases AS source_database
        ON source_database.id = source_row.database_id
       AND source_database.user_id = relation.user_id
      JOIN workspace_database_properties AS source_property
        ON source_property.id = relation.source_property_id
       AND source_property.database_id = relation.source_database_id
       AND source_property.user_id = relation.user_id
      WHERE relation.user_id = $1
        AND relation.target_row_id = ANY($2::uuid[])
        AND source_row.archived = FALSE
      ORDER BY source_database.name, source_row.title, source_row.id
    `,
    [userId, rowIds]
  )
  const backlinks = Object.fromEntries(rowIds.map((id) => [id, []]))
  for (const row of rows) {
    backlinks[row.target_row_id] ||= []
    backlinks[row.target_row_id].push({
      sourceRowId: row.source_row_id,
      sourceRowTitle: row.source_row_title,
      sourceDatabaseId: row.source_database_id,
      sourceDatabaseName: row.source_database_name,
      sourcePropertyId: row.source_property_id,
      sourcePropertyName: row.source_property_name
    })
  }
  return backlinks
}

export default async function workspaceDatabaseRoutes(fastify) {
  fastify.get('/workspace-databases', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const { rows } = await query(
      `
        SELECT database.*, COUNT(row.id) FILTER (WHERE row.archived = FALSE)::integer AS row_count
        FROM workspace_databases AS database
        LEFT JOIN workspace_database_rows AS row
          ON row.database_id = database.id AND row.user_id = database.user_id
        WHERE database.user_id = $1
        GROUP BY database.id
        ORDER BY database.updated_at DESC, database.id ASC
      `,
      [request.currentUser.id]
    )
    return { databases: rows.map(mapWorkspaceDatabase) }
  })

  fastify.post('/workspace-databases', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const name = normalizeWorkspaceDatabaseName(request.body?.name)
      const description = normalizeWorkspaceDatabaseDescription(request.body?.description)
      const icon = normalizeWorkspaceDatabaseIcon(request.body?.icon)
      const properties = normalizeWorkspaceDatabaseProperties(request.body?.properties)
      const requestedViews = Array.isArray(request.body?.views) ? request.body.views : []
      const result = await withTransaction(async (client) => {
        const inserted = await client.query(
          `
            INSERT INTO workspace_databases (user_id, name, description, icon)
            VALUES ($1, $2, $3, $4)
            RETURNING *
          `,
          [request.currentUser.id, name, description, icon]
        )
        const database = inserted.rows[0]
        for (const property of properties) {
          if (property.type === 'relation') {
            await requireDatabase(client, request.currentUser.id, property.config.targetDatabaseId)
          }
          await client.query(
            `
              INSERT INTO workspace_database_properties (
                id, database_id, user_id, name, type, config, display_order
              ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            `,
            [
              property.id,
              database.id,
              request.currentUser.id,
              property.name,
              property.type,
              JSON.stringify(property.config),
              property.displayOrder
            ]
          )
        }
        const viewSources = requestedViews.length
          ? requestedViews
          : [{ name: '表格', type: 'table', config: {}, displayOrder: 0 }]
        for (const [index, view] of viewSources.entries()) {
          const viewName = normalizeWorkspaceDatabaseName(view.name || (view.type === 'board' ? '看板' : '表格'), '视图名称').slice(0, 80)
          const viewType = normalizeWorkspaceDatabaseViewType(view.type)
          const viewConfig = normalizeWorkspaceDatabaseViewConfig(view.config, properties)
          await client.query(
            `
              INSERT INTO workspace_database_views (
                database_id, user_id, name, type, config, display_order
              ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            `,
            [
              database.id,
              request.currentUser.id,
              viewName,
              viewType,
              JSON.stringify(viewConfig),
              Number.isSafeInteger(Number(view.displayOrder)) ? Number(view.displayOrder) : index
            ]
          )
        }
        return {
          database: mapWorkspaceDatabase(database),
          properties: await loadProperties(client, request.currentUser.id, database.id),
          views: await loadViews(client, request.currentUser.id, database.id)
        }
      })
      reply.code(201)
      return result
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.get('/workspace-databases/:databaseId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const database = await requireDatabase(
        { query },
        request.currentUser.id,
        request.params.databaseId
      )
      return {
        database: mapWorkspaceDatabase(database),
        properties: await loadProperties({ query }, request.currentUser.id, database.id),
        views: await loadViews({ query }, request.currentUser.id, database.id)
      }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.patch('/workspace-databases/:databaseId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const database = await withTransaction(async (client) => {
        const existing = await requireDatabase(
          client,
          request.currentUser.id,
          request.params.databaseId,
          { lock: true }
        )
        const name = request.body?.name === undefined
          ? existing.name
          : normalizeWorkspaceDatabaseName(request.body.name)
        const description = request.body?.description === undefined
          ? existing.description
          : normalizeWorkspaceDatabaseDescription(request.body.description)
        const icon = request.body?.icon === undefined
          ? existing.icon
          : normalizeWorkspaceDatabaseIcon(request.body.icon)
        const { rows } = await client.query(
          `
            UPDATE workspace_databases
            SET name = $3, description = $4, icon = $5, updated_at = NOW()
            WHERE id = $1 AND user_id = $2
            RETURNING *
          `,
          [existing.id, request.currentUser.id, name, description, icon]
        )
        return rows[0]
      })
      return { database: mapWorkspaceDatabase(database) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.delete('/workspace-databases/:databaseId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      await withTransaction(async (client) => {
        const database = await requireDatabase(
          client,
          request.currentUser.id,
          request.params.databaseId,
          { lock: true }
        )
        await client.query(
          'DELETE FROM workspace_databases WHERE id = $1 AND user_id = $2',
          [database.id, request.currentUser.id]
        )
      })
      return { ok: true }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.post('/workspace-databases/:databaseId/properties', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const property = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const [normalized] = normalizeWorkspaceDatabaseProperties([request.body], { ensureTitle: false })
        if (normalized.type === 'title') {
          throw new WorkspaceDatabaseError('标题属性已在创建数据库时生成', {
            code: 'workspace_database_title_property_immutable'
          })
        }
        if (normalized.type === 'relation') {
          await requireDatabase(client, request.currentUser.id, normalized.config.targetDatabaseId)
        }
        const order = await client.query(
          `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM workspace_database_properties WHERE database_id = $1`,
          [database.id]
        )
        const { rows } = await client.query(
          `
            INSERT INTO workspace_database_properties (
              id, database_id, user_id, name, type, config, display_order
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            RETURNING *
          `,
          [
            normalized.id,
            database.id,
            request.currentUser.id,
            normalized.name,
            normalized.type,
            JSON.stringify(normalized.config),
            Number(order.rows[0]?.next_order || 0)
          ]
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
        return rows[0]
      })
      reply.code(201)
      return { property: mapWorkspaceDatabaseProperty(property) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.patch('/workspace-databases/:databaseId/properties/:propertyId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const property = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const existing = await requireProperty(client, request.currentUser.id, database.id, request.params.propertyId, { lock: true })
        if (request.body?.type && request.body.type !== existing.type) {
          throw new WorkspaceDatabaseError('已有属性不能直接改变类型，请新建属性后迁移数据', {
            code: 'workspace_database_property_type_immutable'
          })
        }
        const name = request.body?.name === undefined
          ? existing.name
          : normalizeWorkspaceDatabaseName(request.body.name, '属性名称').slice(0, 80)
        const config = request.body?.config === undefined
          ? existing.config
          : normalizeWorkspaceDatabasePropertyConfig(existing.type, request.body.config)
        if (existing.type === 'relation') {
          await requireDatabase(client, request.currentUser.id, config.targetDatabaseId)
        }
        await assertPropertyConfigCompatible(
          client,
          request.currentUser.id,
          database.id,
          existing,
          config
        )
        const displayOrder = request.body?.displayOrder === undefined
          ? Number(existing.display_order || 0)
          : Math.max(0, Math.min(10000, Number(request.body.displayOrder) || 0))
        const { rows } = await client.query(
          `
            UPDATE workspace_database_properties
            SET name = $4, config = $5::jsonb, display_order = $6, updated_at = NOW()
            WHERE id = $1 AND database_id = $2 AND user_id = $3
            RETURNING *
          `,
          [existing.id, database.id, request.currentUser.id, name, JSON.stringify(config), displayOrder]
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
        return rows[0]
      })
      return { property: mapWorkspaceDatabaseProperty(property) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.delete('/workspace-databases/:databaseId/properties/:propertyId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const property = await requireProperty(client, request.currentUser.id, database.id, request.params.propertyId, { lock: true })
        if (property.type === 'title') {
          throw new WorkspaceDatabaseError('标题属性不能删除', {
            code: 'workspace_database_title_property_immutable'
          })
        }
        await client.query(
          `UPDATE workspace_database_rows SET values = values - $1, updated_at = NOW() WHERE database_id = $2 AND user_id = $3`,
          [property.id, database.id, request.currentUser.id]
        )
        await client.query(
          'DELETE FROM workspace_database_properties WHERE id = $1 AND database_id = $2 AND user_id = $3',
          [property.id, database.id, request.currentUser.id]
        )
        await repairViewsAfterPropertyDeletion(
          client,
          request.currentUser.id,
          database.id,
          property.id
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
      })
      return { ok: true }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.post('/workspace-databases/:databaseId/views', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const view = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const properties = await loadProperties(client, request.currentUser.id, database.id)
        const name = normalizeWorkspaceDatabaseName(request.body?.name, '视图名称').slice(0, 80)
        const type = normalizeWorkspaceDatabaseViewType(request.body?.type)
        const config = normalizeWorkspaceDatabaseViewConfig(request.body?.config, properties)
        const order = await client.query(
          `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM workspace_database_views WHERE database_id = $1`,
          [database.id]
        )
        const { rows } = await client.query(
          `
            INSERT INTO workspace_database_views (
              database_id, user_id, name, type, config, display_order
            ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            RETURNING *
          `,
          [database.id, request.currentUser.id, name, type, JSON.stringify(config), Number(order.rows[0]?.next_order || 0)]
        )
        return rows[0]
      })
      reply.code(201)
      return { view: mapWorkspaceDatabaseView(view) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.patch('/workspace-databases/:databaseId/views/:viewId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const view = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const existing = await requireView(client, request.currentUser.id, database.id, request.params.viewId, { lock: true })
        const properties = await loadProperties(client, request.currentUser.id, database.id)
        const name = request.body?.name === undefined
          ? existing.name
          : normalizeWorkspaceDatabaseName(request.body.name, '视图名称').slice(0, 80)
        const type = request.body?.type === undefined
          ? existing.type
          : normalizeWorkspaceDatabaseViewType(request.body.type)
        const config = request.body?.config === undefined
          ? normalizeWorkspaceDatabaseViewConfig(existing.config, properties)
          : normalizeWorkspaceDatabaseViewConfig(request.body.config, properties)
        const displayOrder = request.body?.displayOrder === undefined
          ? Number(existing.display_order || 0)
          : Math.max(0, Math.min(10000, Number(request.body.displayOrder) || 0))
        const { rows } = await client.query(
          `
            UPDATE workspace_database_views
            SET name = $4, type = $5, config = $6::jsonb,
                display_order = $7, updated_at = NOW()
            WHERE id = $1 AND database_id = $2 AND user_id = $3
            RETURNING *
          `,
          [existing.id, database.id, request.currentUser.id, name, type, JSON.stringify(config), displayOrder]
        )
        return rows[0]
      })
      return { view: mapWorkspaceDatabaseView(view) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.delete('/workspace-databases/:databaseId/views/:viewId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const view = await requireView(client, request.currentUser.id, database.id, request.params.viewId, { lock: true })
        const count = await client.query(
          'SELECT COUNT(*)::integer AS count FROM workspace_database_views WHERE database_id = $1 AND user_id = $2',
          [database.id, request.currentUser.id]
        )
        if (Number(count.rows[0]?.count || 0) <= 1) {
          throw new WorkspaceDatabaseError('数据库至少需要保留一个视图', {
            code: 'workspace_database_last_view_required'
          })
        }
        await client.query(
          'DELETE FROM workspace_database_views WHERE id = $1 AND database_id = $2 AND user_id = $3',
          [view.id, database.id, request.currentUser.id]
        )
      })
      return { ok: true }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.get('/workspace-databases/:databaseId/rows', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const database = await requireDatabase({ query }, request.currentUser.id, request.params.databaseId)
      const properties = await loadProperties({ query }, request.currentUser.id, database.id)
      const views = await loadViews({ query }, request.currentUser.id, database.id)
      const includeArchived = String(request.query?.includeArchived || '') === '1'
      const viewId = request.query?.viewId
        ? normalizeWorkspaceDatabaseIdentity(request.query.viewId, '视图 ID')
        : null
      const selectedView = viewId
        ? views.find((view) => view.id === viewId)
        : views[0]
      if (viewId && !selectedView) {
        throw new WorkspaceDatabaseError('视图不存在', {
          code: 'workspace_database_view_not_found',
          statusCode: 404
        })
      }
      const { rows } = await query(
        `
          SELECT *
          FROM workspace_database_rows
          WHERE database_id = $1 AND user_id = $2
            AND ($3::boolean OR archived = FALSE)
          ORDER BY position ASC, created_at ASC, id ASC
          LIMIT 5001
        `,
        [database.id, request.currentUser.id, includeArchived]
      )
      const hasMore = rows.length > 5000
      const mappedRows = rows.slice(0, 5000).map(mapWorkspaceDatabaseRow)
      const visibleRows = selectedView
        ? applyWorkspaceDatabaseView(mappedRows, properties, selectedView.config)
        : mappedRows
      return {
        database: mapWorkspaceDatabase(database),
        properties,
        views,
        selectedViewId: selectedView?.id || null,
        rows: visibleRows,
        limit: 5000,
        hasMore,
        truncated: hasMore,
        backlinksByRow: await loadBacklinks(
          request.currentUser.id,
          visibleRows.map((row) => row.id)
        )
      }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.post('/workspace-databases/:databaseId/rows', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const row = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const properties = await loadProperties(client, request.currentUser.id, database.id)
        const title = normalizeWorkspaceDatabaseRowTitle(request.body?.title)
        const values = normalizeWorkspaceDatabaseRowValues(request.body?.values, properties)
        const relations = await assertWorkspaceDatabaseRelationTargets(client, request.currentUser.id, null, properties, values)
        const order = await client.query(
          `SELECT COALESCE(MAX(position), 0) + 1024 AS next_position FROM workspace_database_rows WHERE database_id = $1`,
          [database.id]
        )
        const { rows } = await client.query(
          `
            INSERT INTO workspace_database_rows (
              database_id, user_id, title, values, position
            ) VALUES ($1, $2, $3, $4::jsonb, $5)
            RETURNING *
          `,
          [database.id, request.currentUser.id, title, JSON.stringify(values), String(order.rows[0]?.next_position || 1024)]
        )
        await syncWorkspaceDatabaseRelations(
          client,
          request.currentUser.id,
          rows[0].id,
          database.id,
          relations
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
        return rows[0]
      })
      reply.code(201)
      return { row: mapWorkspaceDatabaseRow(row) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.patch('/workspace-databases/:databaseId/rows/:rowId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const row = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const existing = await requireRow(client, request.currentUser.id, database.id, request.params.rowId, { lock: true })
        const properties = await loadProperties(client, request.currentUser.id, database.id)
        const title = request.body?.title === undefined
          ? existing.title
          : normalizeWorkspaceDatabaseRowTitle(request.body.title)
        const mergedValues = { ...(existing.values || {}) }
        if (request.body?.values !== undefined) {
          if (!request.body.values || typeof request.body.values !== 'object' || Array.isArray(request.body.values)) {
            throw new WorkspaceDatabaseError('记录属性值必须是对象', {
              code: 'workspace_database_row_values_invalid'
            })
          }
          for (const [propertyId, value] of Object.entries(request.body.values)) {
            if (value === null || value === undefined || value === '') delete mergedValues[propertyId]
            else mergedValues[propertyId] = value
          }
        }
        const values = normalizeWorkspaceDatabaseRowValues(mergedValues, properties)
        const relations = await assertWorkspaceDatabaseRelationTargets(client, request.currentUser.id, existing.id, properties, values)
        const archived = request.body?.archived === undefined
          ? Boolean(existing.archived)
          : Boolean(request.body.archived)
        const position = request.body?.position === undefined
          ? String(existing.position || 0)
          : String(Math.trunc(Number(request.body.position) || 0))
        const { rows } = await client.query(
          `
            UPDATE workspace_database_rows
            SET title = $4, values = $5::jsonb, archived = $6,
                position = $7::bigint, updated_at = NOW()
            WHERE id = $1 AND database_id = $2 AND user_id = $3
            RETURNING *
          `,
          [existing.id, database.id, request.currentUser.id, title, JSON.stringify(values), archived, position]
        )
        await syncWorkspaceDatabaseRelations(
          client,
          request.currentUser.id,
          existing.id,
          database.id,
          relations
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
        return rows[0]
      })
      return { row: mapWorkspaceDatabaseRow(row) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.delete('/workspace-databases/:databaseId/rows/:rowId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const row = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const existing = await requireRow(client, request.currentUser.id, database.id, request.params.rowId, { lock: true })
        const { rows } = await client.query(
          `
            UPDATE workspace_database_rows
            SET archived = TRUE, updated_at = NOW()
            WHERE id = $1 AND database_id = $2 AND user_id = $3
            RETURNING *
          `,
          [existing.id, database.id, request.currentUser.id]
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
        return rows[0]
      })
      return { row: mapWorkspaceDatabaseRow(row) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })

  fastify.post('/workspace-databases/:databaseId/rows/:rowId/restore', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    try {
      const row = await withTransaction(async (client) => {
        const database = await requireDatabase(client, request.currentUser.id, request.params.databaseId, { lock: true })
        const existing = await requireRow(client, request.currentUser.id, database.id, request.params.rowId, { lock: true })
        const { rows } = await client.query(
          `
            UPDATE workspace_database_rows
            SET archived = FALSE, updated_at = NOW()
            WHERE id = $1 AND database_id = $2 AND user_id = $3
            RETURNING *
          `,
          [existing.id, database.id, request.currentUser.id]
        )
        await client.query('UPDATE workspace_databases SET updated_at = NOW() WHERE id = $1', [database.id])
        return rows[0]
      })
      return { row: mapWorkspaceDatabaseRow(row) }
    } catch (error) {
      return sendWorkspaceDatabaseError(reply, error)
    }
  })
}
