import { mapNote } from './notes.js'

export const COLLABORATION_ROLES = Object.freeze([
  'owner',
  'editor',
  'commenter',
  'viewer'
])

const ROLE_RANK = Object.freeze({
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4
})

export function normalizeCollaborationRole(value, fallback = '') {
  const role = String(value || '').trim().toLowerCase()
  return ['editor', 'commenter', 'viewer'].includes(role) ? role : fallback
}

export function accessAllows(actualRole, requiredRole) {
  return Number(ROLE_RANK[actualRole] || 0) >= Number(ROLE_RANK[requiredRole] || 0)
}

export function normalizeCommentBody(value) {
  const body = String(value || '').trim()
  return body.length >= 1 && body.length <= 4000 ? body : ''
}

export function normalizeCommentBlockId(value) {
  const blockId = String(value || '').trim()
  if (!blockId) return null
  return blockId.length <= 160 ? blockId : ''
}

export function normalizeCommentSelection(value) {
  if (value === null || value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const output = {}
  for (const key of ['from', 'to', 'text']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (key === 'text') {
      const text = String(value.text || '').slice(0, 500)
      if (text) output.text = text
      continue
    }
    const number = Number(value[key])
    if (!Number.isSafeInteger(number) || number < 0) return undefined
    output[key] = number
  }
  if (
    output.from !== undefined
    && output.to !== undefined
    && output.to < output.from
  ) return undefined
  return output
}

export async function getNoteAccess(queryFn, userId, noteId, {
  forUpdate = false
} = {}) {
  const { rows } = await queryFn(
    `
      SELECT
        n.*,
        owner.username AS owner_username,
        CASE
          WHEN n.user_id = $2 THEN 'owner'
          ELSE collaborator.role
        END AS access_role
      FROM notes n
      JOIN users owner ON owner.id = n.user_id
      LEFT JOIN note_collaborators collaborator
        ON collaborator.note_id = n.id
       AND collaborator.user_id = $2
      WHERE n.id = $1
        AND (n.user_id = $2 OR collaborator.user_id = $2)
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE OF n' : ''}
    `,
    [noteId, userId]
  )
  return rows[0] || null
}

export async function navNoteAudience(queryFn, noteId) {
  const { rows } = await queryFn(
    `SELECT nav_note_sync_audience($1) AS audience`,
    [noteId]
  )
  return Array.isArray(rows[0]?.audience) ? rows[0].audience : []
}

export async function requireNoteAccess({
  queryFn,
  userId,
  noteId,
  reply,
  requiredRole = 'viewer',
  forUpdate = false
}) {
  const access = await getNoteAccess(queryFn, userId, noteId, { forUpdate })
  if (!access) {
    reply.code(404)
    return null
  }
  if (!accessAllows(access.access_role, requiredRole)) {
    reply.code(403)
    return null
  }
  return access
}

export function mapCollaborationNote(record) {
  return {
    ...mapNote(record),
    accessRole: record.access_role || 'viewer',
    owner: {
      id: record.user_id,
      username: record.owner_username || ''
    },
    collaborative: record.access_role !== 'owner' || Number(record.collaborator_count || 0) > 0,
    collaboratorCount: Number(record.collaborator_count || 0),
    openCommentCount: Number(record.open_comment_count || 0)
  }
}

export function mapCollaborator(record) {
  return {
    noteId: record.note_id || null,
    userId: record.user_id,
    username: record.username || '',
    role: record.role,
    invitedBy: record.invited_by || null,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}

export function mapComment(record) {
  return {
    id: record.id,
    noteId: record.note_id,
    userId: record.user_id,
    username: record.username || '',
    parentId: record.parent_id || null,
    blockId: record.block_id || null,
    selection: record.selection || null,
    body: record.body,
    status: record.status,
    resolvedBy: record.resolved_by || null,
    resolvedAt: record.resolved_at || null,
    editedAt: record.edited_at || null,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}

export function mapSyncEvent(record) {
  return {
    cursor: Number(record.id),
    noteId: record.note_id || null,
    actorUserId: record.actor_user_id || null,
    kind: record.event_kind,
    entityId: record.entity_id,
    revision: record.revision === null || record.revision === undefined
      ? null
      : Number(record.revision),
    payload: record.payload || {},
    createdAt: record.created_at
  }
}
