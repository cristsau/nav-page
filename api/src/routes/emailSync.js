import { config } from '../config.js'
import { query } from '../db/index.js'
import {
  EMAIL_INGEST_WAKE_CHANNEL,
  notifyEmailWake
} from '../lib/emailIngestWake.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const PUBLIC_ERROR_CODE_PATTERN = /^[A-Z0-9_.-]{1,64}$/
const MANUAL_SYNC_COALESCE_SECONDS = 5

function publicErrorCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return PUBLIC_ERROR_CODE_PATTERN.test(code) ? code : null
}

async function ownedRuntimeAccount(accountId, userId, queryFn) {
  const { rows } = await queryFn(
    `SELECT account.id, account.source_key, account.enabled, owner.username,
            account.sync_request_generation, account.sync_completed_generation,
            account.last_sync_requested_at
     FROM email_accounts AS account
     JOIN users AS owner ON owner.id = account.user_id
     WHERE account.id = $1 AND account.user_id = $2
     LIMIT 1`,
    [accountId, userId]
  )
  return rows[0] || null
}

function runtimeCanSync(account) {
  return account?.enabled === true
    && String(account.source_key || '').trim().toLowerCase()
      === String(config.emailSourceKey || '').trim().toLowerCase()
    && String(account.username || '').trim().toLowerCase()
      === String(config.emailOwnerUsername || '').trim().toLowerCase()
    && config.emailIngestEnabled === true
}

export default async function emailSyncRoutes(fastify, options = {}) {
  const queryFn = typeof options.queryFn === 'function' ? options.queryFn : query

  fastify.post('/email/accounts/:accountId/sync', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.params.accountId || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(accountId)) {
      reply.code(400)
      return { error: 'Invalid email account id' }
    }
    const account = await ownedRuntimeAccount(accountId, request.currentUser.id, queryFn)
    if (!account) {
      reply.code(404)
      return { error: 'Email account not found' }
    }
    if (!runtimeCanSync(account)) {
      reply.code(409)
      return { error: 'This email account is not attached to the active IMAP worker' }
    }
    const updated = await queryFn(
      `UPDATE email_accounts
       SET sync_request_generation = sync_request_generation + 1,
           last_sync_requested_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
         AND (
           last_sync_requested_at IS NULL
           OR last_sync_requested_at <= NOW() - ($3::integer * INTERVAL '1 second')
         )
       RETURNING sync_request_generation, sync_completed_generation, last_sync_requested_at`,
      [accountId, request.currentUser.id, MANUAL_SYNC_COALESCE_SECONDS]
    )
    const state = updated.rows[0] || await ownedRuntimeAccount(accountId, request.currentUser.id, queryFn)
    let wakeDelivered = null
    if (updated.rowCount > 0) {
      try {
        await notifyEmailWake(queryFn, EMAIL_INGEST_WAKE_CHANNEL, {
          accountId,
          sourceKey: account.source_key
        })
        wakeDelivered = true
      } catch {
        // The generation update is durable. The worker's bounded reconciliation
        // poll will observe it even if LISTEN/NOTIFY is temporarily unavailable.
        wakeDelivered = false
      }
    }
    reply.code(202)
    const generation = Number(state.sync_request_generation || 0)
    const coalesced = updated.rowCount === 0
    return {
      queued: true,
      generation,
      status: coalesced ? 'coalesced' : 'queued',
      accepted: true,
      coalesced,
      wakeDelivered,
      requestGeneration: generation,
      completedGeneration: Number(state.sync_completed_generation || 0),
      requestedAt: state.last_sync_requested_at || null
    }
  })

  fastify.get('/email/accounts/:accountId/sync-status', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.params.accountId || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(accountId)) {
      reply.code(400)
      return { error: 'Invalid email account id' }
    }
    const { rows } = await queryFn(
      `SELECT account.id, account.sync_request_generation, account.sync_completed_generation,
              account.last_sync_requested_at, account.last_sync_started_at,
              account.last_sync_completed_at, account.last_idle_event_at,
              account.last_error_at, account.last_error_code,
              COALESCE(folder_state.ingest_lag_messages, 0)::integer AS ingest_lag_messages,
              mailbox.last_cached_at,
              COALESCE(classification.pending_count, 0)::integer AS classification_pending,
              COALESCE(classification.oldest_seconds, 0)::integer AS classification_oldest_seconds
       FROM email_accounts AS account
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(GREATEST(COALESCE(folder.uid_next, 1) - 1 - folder.last_uid, 0)), 0)
                  AS ingest_lag_messages
         FROM email_folders AS folder
         WHERE folder.account_id = account.id AND folder.user_id = account.user_id
           AND folder.selectable = TRUE
       ) AS folder_state ON TRUE
       LEFT JOIN LATERAL (
         SELECT MAX(message.created_at) AS last_cached_at
         FROM email_messages AS message
         WHERE message.account_id = account.id AND message.user_id = account.user_id
       ) AS mailbox ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS pending_count,
                EXTRACT(EPOCH FROM (NOW() - MIN(job.created_at))) AS oldest_seconds
         FROM email_classification_jobs AS job
         WHERE job.account_id = account.id AND job.user_id = account.user_id
           AND job.status IN ('pending', 'retry_wait', 'running')
       ) AS classification ON TRUE
       WHERE account.id = $1 AND account.user_id = $2
       LIMIT 1`,
      [accountId, request.currentUser.id]
    )
    if (!rows[0]) {
      reply.code(404)
      return { error: 'Email account not found' }
    }
    const row = rows[0]
    const requestGeneration = Number(row.sync_request_generation || 0)
    const completedGeneration = Number(row.sync_completed_generation || 0)
    return {
      accountId,
      pending: requestGeneration > completedGeneration,
      requestGeneration,
      completedGeneration,
      requestedAt: row.last_sync_requested_at,
      startedAt: row.last_sync_started_at,
      completedAt: row.last_sync_completed_at,
      lastIdleEventAt: row.last_idle_event_at,
      lastErrorAt: publicErrorCode(row.last_error_code) ? row.last_error_at : null,
      lastErrorCode: publicErrorCode(row.last_error_code),
      lastCachedAt: row.last_cached_at,
      ingestLagMessages: Math.max(0, Number(row.ingest_lag_messages || 0)),
      classification: {
        pending: Math.max(0, Number(row.classification_pending || 0)),
        oldestPendingSeconds: Math.max(0, Number(row.classification_oldest_seconds || 0))
      }
    }
  })
}
