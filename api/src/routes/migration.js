import { withTransaction } from '../db/index.js'

function toTimestamp(value) {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}

function toJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value)
}

export default async function migrationRoutes(fastify) {
  fastify.post('/migration/import-local', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const data = request.body?.data || {}
    const groups = Array.isArray(data.groups) ? data.groups : []
    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : []
    const notes = Array.isArray(data.notes) ? data.notes : []
    const customEngines = Array.isArray(data.customEngines) ? data.customEngines : []
    const shares = Array.isArray(data.shares) ? data.shares : []
    const settings = Array.isArray(data.settings) ? data.settings : []

    await withTransaction(async (client) => {
      await client.query('DELETE FROM nav_bookmarks WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM nav_groups WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM note_shares WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM notes WHERE user_id = $1', [request.currentUser.id])
      await client.query('DELETE FROM custom_search_engines WHERE user_id = $1', [request.currentUser.id])
      await client.query(
        `
          DELETE FROM user_settings
          WHERE user_id = $1
            AND key NOT IN ('telegramConfig', 'telegramUpdateOffset')
        `,
        [request.currentUser.id]
      )

      for (const group of groups) {
        await client.query(
          `
            INSERT INTO nav_groups (
              id,
              user_id,
              name,
              icon,
              color,
              display_order,
              collapsed,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), COALESCE($9, NOW()))
          `,
          [
            group.id,
            request.currentUser.id,
            String(group.name || 'Untitled'),
            String(group.icon || '📁'),
            String(group.color || '#3b82f6'),
            Number(group.order || 0),
            Boolean(group.collapsed),
            toTimestamp(group.createdAt),
            toTimestamp(group.updatedAt)
          ]
        )
      }

      for (const bookmark of bookmarks) {
        await client.query(
          `
            INSERT INTO nav_bookmarks (
              id,
              user_id,
              group_id,
              title,
              url,
              favicon,
              description,
              tags,
              display_order,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, COALESCE($10, NOW()), COALESCE($11, NOW()))
          `,
          [
            bookmark.id,
            request.currentUser.id,
            bookmark.groupId,
            String(bookmark.title || 'Untitled'),
            String(bookmark.url || ''),
            String(bookmark.favicon || ''),
            String(bookmark.description || ''),
            toJson(bookmark.tags, []),
            Number(bookmark.order || 0),
            toTimestamp(bookmark.createdAt),
            toTimestamp(bookmark.updatedAt)
          ]
        )
      }

      for (const note of notes) {
        await client.query(
          `
            INSERT INTO notes (
              id,
              user_id,
              type,
              title,
              content,
              encrypted,
              password_hash,
              pinned,
              tags,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10, NOW()), COALESCE($11, NOW()))
          `,
          [
            note.id,
            request.currentUser.id,
            String(note.type || 'memo'),
            String(note.title || 'Untitled'),
            String(note.content || ''),
            Boolean(note.encrypted),
            String(note.password || ''),
            Boolean(note.pinned),
            toJson(note.tags, []),
            toTimestamp(note.createdAt),
            toTimestamp(note.updatedAt)
          ]
        )
      }

      for (const share of shares) {
        await client.query(
          `
            INSERT INTO note_shares (
              id,
              user_id,
              note_id,
              code,
              expire_at,
              view_count,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
          `,
          [
            share.id,
            request.currentUser.id,
            share.noteId,
            String(share.code || ''),
            toTimestamp(share.expireAt),
            Number(share.viewCount || 0),
            toTimestamp(share.createdAt)
          ]
        )
      }

      for (const engine of customEngines) {
        await client.query(
          `
            INSERT INTO custom_search_engines (
              id,
              user_id,
              name,
              icon,
              url,
              display_order,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), COALESCE($8, NOW()))
          `,
          [
            engine.id,
            request.currentUser.id,
            String(engine.name || 'Custom Engine'),
            String(engine.icon || '🔍'),
            String(engine.url || ''),
            Number(engine.order || 0),
            toTimestamp(engine.createdAt),
            toTimestamp(engine.updatedAt)
          ]
        )
      }

      for (const setting of settings) {
        await client.query(
          `
            INSERT INTO user_settings (user_id, key, value, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (user_id, key)
            DO UPDATE SET
              value = EXCLUDED.value,
              updated_at = NOW()
          `,
          [request.currentUser.id, setting.id, JSON.stringify(setting.value)]
        )
      }
    })

    return {
      ok: true,
      imported: {
        groups: groups.length,
        bookmarks: bookmarks.length,
        notes: notes.length,
        customEngines: customEngines.length,
        shares: shares.length,
        settings: settings.length
      }
    }
  })
}
