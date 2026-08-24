import { createHash } from 'node:crypto'
import {
  docs,
  getYDoc,
  setupWSConnection,
  setPersistence
} from '@y/websocket-server/utils'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import { hashSessionToken } from './auth.js'
import { archiveNoteVersion, pruneNoteVersions } from './noteVersions.js'
import { sanitizeTiptapDocument, tiptapDocumentText } from './noteRichContent.js'
import { navNoteAudience } from './noteCollaboration.js'
import { getImgBedOrigin } from './noteAttachments.js'
import { parseAllowedOrigins } from './requestSecurity.js'

const WS_PATH_PREFIX = '/api/collaboration/ws/'
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const documentContexts = new WeakMap()
const activePersistenceWrites = new Set()
let persistenceConfigured = false
let persistenceLogger = console

function parseCookies(value) {
  const cookies = new Map()
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    const raw = part.slice(separator + 1).trim()
    try {
      cookies.set(key, decodeURIComponent(raw))
    } catch {
      cookies.set(key, raw)
    }
  }
  return cookies
}

function noteIdFromDocumentName(value) {
  const name = String(value || '').split('?', 1)[0]
  const noteId = decodeURIComponent(name.split('/').filter(Boolean).at(-1) || '')
  return NOTE_ID_PATTERN.test(noteId) ? noteId : ''
}

async function loadSession(request) {
  const token = parseCookies(request.headers.cookie).get(config.sessionCookieName)
  if (!token) return null
  const { rows } = await query(
    `
      SELECT u.id, u.username, u.role, u.status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND u.status = 'approved'
      LIMIT 1
    `,
    [hashSessionToken(token)]
  )
  return rows[0] || null
}

async function authorizeRealtimeEdit(userId, noteId) {
  const { rows } = await query(
    `
      SELECT
        n.encrypted,
        CASE WHEN n.user_id = $2 THEN 'owner' ELSE c.role END AS access_role
      FROM notes n
      LEFT JOIN note_collaborators c
        ON c.note_id = n.id AND c.user_id = $2
      WHERE n.id = $1
        AND (n.user_id = $2 OR c.user_id = $2)
      LIMIT 1
    `,
    [noteId, userId]
  )
  const access = rows[0]
  return Boolean(
    access
    && !access.encrypted
    && ['owner', 'editor'].includes(access.access_role)
  )
}

function updateHash(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function persistDocument(noteId, ydoc, updates = []) {
  if (!noteId) return
  const state = Buffer.from(Y.encodeStateAsUpdate(ydoc))
  const stateVector = Buffer.from(Y.encodeStateVector(ydoc))
  const merged = updates.length
    ? Buffer.from(Y.mergeUpdates(updates))
    : state
  let documentJson
  try {
    documentJson = sanitizeTiptapDocument(
      yDocToProsemirrorJSON(ydoc, 'default'),
      { allowedImageOrigin: getImgBedOrigin(config.imgBedBaseUrl) }
    )
  } catch {
    documentJson = null
  }

  await withTransaction(async (client) => {
    const locked = await client.query(
      'SELECT * FROM notes WHERE id = $1 AND encrypted = FALSE FOR UPDATE',
      [noteId]
    )
    if (!locked.rows.length) return

    await client.query(
      `
        INSERT INTO note_crdt_documents (
          note_id, state, state_vector, update_count, compacted_through, updated_at
        ) VALUES ($1, $2, $3, 1, 0, NOW())
        ON CONFLICT (note_id) DO UPDATE
        SET state = EXCLUDED.state,
            state_vector = EXCLUDED.state_vector,
            update_count = note_crdt_documents.update_count + 1,
            updated_at = NOW()
      `,
      [noteId, state, stateVector]
    )
    await client.query(
      `
        INSERT INTO note_crdt_updates (note_id, update, update_hash)
        VALUES ($1, $2, $3)
        ON CONFLICT (note_id, update_hash) DO NOTHING
      `,
      [noteId, merged, updateHash(merged)]
    )

    if (documentJson) {
      const recentVersion = await client.query(
        `SELECT 1 FROM note_versions WHERE note_id = $1 AND created_at > NOW() - INTERVAL '30 seconds' LIMIT 1`,
        [noteId]
      )
      if (!recentVersion.rows.length) await archiveNoteVersion(client, locked.rows[0])
      await client.query(
        `
          UPDATE notes
          SET content = $2,
              content_format = 'tiptap-json',
              content_json = $3::jsonb,
              content_json_encrypted = NULL,
              revision = revision + 1,
              updated_at = NOW()
          WHERE id = $1
        `,
        [noteId, tiptapDocumentText(documentJson), JSON.stringify(documentJson)]
      )
      await pruneNoteVersions(client, locked.rows[0].user_id, noteId)
    }

    const audience = await navNoteAudience(client.query.bind(client), noteId)
    if (audience.length) {
      await client.query(
        `
          INSERT INTO note_sync_events (
            note_id, event_kind, entity_id, audience_user_ids, payload
          ) VALUES ($1, 'crdt.update', $1::text, $2::uuid[], $3::jsonb)
        `,
        [noteId, audience, JSON.stringify({ updateHash: updateHash(merged) })]
      )
    }
  })
}

function configurePersistence(logger) {
  persistenceLogger = logger || console
  if (persistenceConfigured) return
  persistenceConfigured = true
  setPersistence({
    bindState(documentName, ydoc) {
      const noteId = noteIdFromDocumentName(documentName)
      const context = {
        noteId,
        loading: true,
        updates: [],
        timer: null,
        flushing: Promise.resolve(),
        ready: null
      }
      documentContexts.set(ydoc, context)
      context.ready = (async () => {
        const { rows } = await query(
          'SELECT state FROM note_crdt_documents WHERE note_id = $1 LIMIT 1',
          [noteId]
        )
        if (rows[0]?.state?.length) Y.applyUpdate(ydoc, rows[0].state)
        context.loading = false
        ydoc.on('update', (update) => {
          if (context.loading) return
          context.updates.push(update)
          if (context.timer) clearTimeout(context.timer)
          context.timer = setTimeout(() => {
            const pending = context.updates.splice(0)
            context.flushing = context.flushing
              .then(() => persistDocument(noteId, ydoc, pending))
              .catch((error) => {
                persistenceLogger.error?.({ error: error?.message, noteId }, 'collaboration document persistence failed')
              })
          }, 1500)
        })
      })()
      return context.ready
    },
    async writeState(documentName, ydoc) {
      const write = (async () => {
        const context = documentContexts.get(ydoc)
        if (context?.timer) clearTimeout(context.timer)
        const pending = context?.updates?.splice(0) || []
        await context?.ready
        await context?.flushing
        if (!pending.length) return
        await persistDocument(noteIdFromDocumentName(documentName), ydoc, pending)
      })()
      activePersistenceWrites.add(write)
      try {
        await write
      } finally {
        activePersistenceWrites.delete(write)
      }
    }
  })
}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) return socket.destroy()
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
  socket.destroy()
}

export function attachCollaborationWebSocket(server, logger = console) {
  configurePersistence(logger)
  const allowedOrigins = new Set(parseAllowedOrigins(config.corsOrigin))
  const wss = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 1024 * 1024 })
  wss.on('connection', (socket, request) => setupWSConnection(socket, request, {
    docName: request.navDocumentName,
    gc: true
  }))

  const handleUpgrade = async (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', 'http://nav.internal')
      if (!url.pathname.startsWith(WS_PATH_PREFIX)) return
      const noteId = noteIdFromDocumentName(url.pathname)
      const origin = String(request.headers.origin || '')
      if (!noteId) return rejectUpgrade(socket, 400, 'Bad Request')
      if (!origin || !allowedOrigins.has(origin)) return rejectUpgrade(socket, 403, 'Forbidden')
      const user = await loadSession(request)
      if (!user) return rejectUpgrade(socket, 401, 'Unauthorized')
      if (!(await authorizeRealtimeEdit(user.id, noteId))) return rejectUpgrade(socket, 403, 'Forbidden')
      const documentName = url.pathname.replace(/^\/+/, '')
      const document = getYDoc(documentName, true)
      try {
        await documentContexts.get(document)?.ready
      } catch (error) {
        docs.delete(documentName)
        document.destroy()
        throw error
      }
      request.navUser = user
      request.navDocumentName = documentName
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.navUser = user
        wss.emit('connection', webSocket, request)
      })
    } catch (error) {
      logger.warn?.({ error: error?.message }, 'collaboration websocket upgrade rejected')
      rejectUpgrade(socket, 500, 'Internal Server Error')
    }
  }
  server.on('upgrade', handleUpgrade)
  return async () => {
    server.off('upgrade', handleUpgrade)
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await Promise.allSettled([...activePersistenceWrites])
  }
}
