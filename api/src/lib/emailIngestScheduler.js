import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { config } from '../config.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { processInboundEmail } from './emailEvents.js'

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function validateEmailIngestPolicy(policy = {}) {
  const normalized = {
    pollIntervalSeconds: boundedInteger(policy.pollIntervalSeconds, 60, 30, 3600),
    initialLookback: boundedInteger(policy.initialLookback, 50, 1, 500),
    batchSize: boundedInteger(policy.batchSize, 100, 1, 500),
    maxMessageBytes: boundedInteger(policy.maxMessageBytes, 512 * 1024, 32 * 1024, 2 * 1024 * 1024)
  }
  return normalized
}

export function validateMxrouteImapConfig(runtimeConfig = config) {
  const sourceKey = String(runtimeConfig.emailSourceKey || '').trim().toLowerCase()
  if (!/^[a-z0-9_.-]{1,80}$/.test(sourceKey)) throw new Error('Email source key is invalid')
  if (!runtimeConfig.emailOwnerUsername) throw new Error('Email owner username is not configured')
  if (!runtimeConfig.imapHost || !runtimeConfig.imapUsername || !runtimeConfig.imapPasswordFile) {
    throw new Error('MXroute IMAP configuration is incomplete')
  }
  if (!runtimeConfig.imapSecure) throw new Error('MXroute IMAP must use implicit TLS')
  if (Number(runtimeConfig.imapPort) !== 993) throw new Error('MXroute IMAP must use TLS port 993')
  if (!runtimeConfig.imapMailbox || /[\r\n\u0000]/.test(runtimeConfig.imapMailbox)) {
    throw new Error('IMAP mailbox name is invalid')
  }
  return sourceKey
}

function firstAddress(addresses) {
  const address = Array.isArray(addresses) ? addresses[0] : addresses
  return {
    name: String(address?.name || '').normalize('NFKC').trim().slice(0, 320),
    address: String(address?.address || '').normalize('NFKC').trim().toLowerCase().slice(0, 320)
  }
}

function joinAddresses(addresses) {
  return (Array.isArray(addresses) ? addresses : [])
    .map((address) => String(address?.address || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
    .slice(0, 1000)
}

export async function parseImapMessage(message, maxMessageBytes) {
  const source = Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source || [])
  const oversized = Number(message.size || 0) > maxMessageBytes || source.length > maxMessageBytes
  let parsed = null
  if (source.length && !oversized) {
    parsed = await simpleParser(source, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      maxHtmlLengthToParse: 0
    })
  }
  try {
    const envelope = message.envelope || {}
    const parsedFrom = firstAddress(parsed?.from?.value)
    const envelopeFrom = firstAddress(envelope.from)
    const sender = parsedFrom.address ? parsedFrom : envelopeFrom
    const receivedAt = parsed?.date || message.internalDate || envelope.date || new Date()
    return {
      mailboxUid: Number(message.uid),
      messageId: String(parsed?.messageId || envelope.messageId || '').trim(),
      senderName: sender.name,
      senderAddress: sender.address,
      recipient: joinAddresses(parsed?.to?.value || envelope.to),
      subject: String(parsed?.subject || envelope.subject || '(无主题)').slice(0, 500),
      text: oversized
        ? '[邮件正文超过安全处理上限，已仅根据发件人和标题分类。]'
        : String(parsed?.text || '').slice(0, 120_000),
      receivedAt
    }
  } finally {
    // Attachments are intentionally neither persisted nor sent to AI. Clear
    // bounded buffers created by mailparser before releasing this message.
    for (const attachment of parsed?.attachments || []) {
      if (Buffer.isBuffer(attachment?.content)) attachment.content.fill(0)
    }
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try { await observer?.[method]?.(payload) } catch (error) {
    logger?.warn?.({ err: error }, 'email ingest status could not be recorded')
  }
}

export function startEmailIngestScheduler({
  enabled,
  policy,
  poolInstance,
  runtimeConfig = config,
  logger,
  observer,
  ImapClient = ImapFlow,
  readSecretImpl = readOwnerSecretFile,
  processFn = processInboundEmail,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailIngestPolicy(policy)
  const sourceKey = validateMxrouteImapConfig(runtimeConfig)
  let stopped = false
  let imap = null
  let activeRun = null
  let timer = null
  let reconnectTimer = null

  const scheduleSoon = (delay = 250) => {
    if (stopped || reconnectTimer) return
    reconnectTimer = timerApi.setTimeout(() => {
      reconnectTimer = null
      void run()
    }, delay)
    reconnectTimer?.unref?.()
  }

  const ensureConnected = async () => {
    if (imap?.usable) return imap
    try { imap?.close?.() } catch {}
    const password = await readSecretImpl(runtimeConfig.imapPasswordFile, {
      label: 'IMAP password',
      maxBytes: 4096
    })
    const client = new ImapClient({
      host: runtimeConfig.imapHost,
      port: Number(runtimeConfig.imapPort),
      secure: true,
      auth: { user: runtimeConfig.imapUsername, pass: password },
      disableAutoIdle: false,
      maxIdleTime: Math.max(60_000, validated.pollIntervalSeconds * 1000),
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false
    })
    client.on('exists', () => scheduleSoon())
    client.on('error', (error) => logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'MXroute IMAP connection error'))
    client.on('close', () => {
      if (imap === client) imap = null
      scheduleSoon(5_000)
    })
    await client.connect()
    imap = client
    return client
  }

  const syncMailbox = async () => {
    const user = await poolInstance.query(
      `SELECT id FROM users WHERE username = $1 AND status = 'approved' LIMIT 1`,
      [runtimeConfig.emailOwnerUsername]
    )
    if (!user.rows[0]) throw new Error('Configured email owner user was not found')
    const userId = user.rows[0].id
    const client = await ensureConnected()
    const lock = await client.getMailboxLock(runtimeConfig.imapMailbox)
    let messages
    let uidValidity
    let lastUid
    try {
      uidValidity = String(client.mailbox?.uidValidity || '')
      const state = await poolInstance.query(
        `SELECT uid_validity, last_uid FROM email_mailbox_state WHERE source_key = $1 LIMIT 1`,
        [sourceKey]
      )
      const uidNext = Number(client.mailbox?.uidNext || 1)
      lastUid = Number(state.rows[0]?.last_uid || 0)
      if (!state.rows[0] || String(state.rows[0].uid_validity || '') !== uidValidity) {
        lastUid = Math.max(0, uidNext - validated.initialLookback - 1)
      }
      const startUid = Math.max(1, lastUid + 1)
      if (uidNext > 0 && startUid >= uidNext) messages = []
      else {
        const endUid = Math.min(uidNext - 1, startUid + validated.batchSize - 1)
        messages = await client.fetchAll(
          `${startUid}:${endUid}`,
          { uid: true, envelope: true, internalDate: true, size: true },
          { uid: true }
        )
        for (const message of messages) {
          if (Number(message.size || 0) > validated.maxMessageBytes) continue
          const sourceMessage = await client.fetchOne(
            Number(message.uid),
            { source: true },
            { uid: true }
          )
          message.source = sourceMessage?.source || null
        }
      }
    } finally {
      lock.release()
    }

    const summary = { processed: 0, inserted: 0, duplicates: 0, tier1: 0, tier2: 0, tier3: 0 }
    for (const message of messages.sort((left, right) => Number(left.uid) - Number(right.uid))) {
      const parsed = await parseImapMessage(message, validated.maxMessageBytes)
      const result = await processFn({ userId, sourceKey, email: parsed, logger })
      summary.processed += 1
      if (result.inserted) {
        summary.inserted += 1
        summary[`tier${result.event.tier}`] += 1
        if (result.duplicate) summary.duplicates += 1
      } else summary.duplicates += 1
      lastUid = Math.max(lastUid, Number(message.uid || 0))
      await poolInstance.query(
        `
          INSERT INTO email_mailbox_state (
            source_key, user_id, uid_validity, last_uid,
            last_connected_at, last_message_at, last_error_at,
            last_error_code, updated_at
          ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NULL, NULL, NOW())
          ON CONFLICT (source_key) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            uid_validity = EXCLUDED.uid_validity,
            last_uid = CASE
              WHEN email_mailbox_state.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
                THEN EXCLUDED.last_uid
              ELSE GREATEST(email_mailbox_state.last_uid, EXCLUDED.last_uid)
            END,
            last_connected_at = NOW(),
            last_message_at = NOW(),
            last_error_at = NULL,
            last_error_code = NULL,
            updated_at = NOW()
        `,
        [sourceKey, userId, uidValidity, lastUid]
      )
    }
    if (!messages.length) {
      await poolInstance.query(
        `
          INSERT INTO email_mailbox_state (
            source_key, user_id, uid_validity, last_uid, last_connected_at, updated_at
          ) VALUES ($1, $2, $3, $4, NOW(), NOW())
          ON CONFLICT (source_key) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            last_uid = CASE
              WHEN email_mailbox_state.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
                THEN EXCLUDED.last_uid
              ELSE GREATEST(email_mailbox_state.last_uid, EXCLUDED.last_uid)
            END,
            uid_validity = EXCLUDED.uid_validity,
            last_connected_at = NOW(),
            last_error_at = NULL,
            last_error_code = NULL,
            updated_at = NOW()
        `,
        [sourceKey, userId, uidValidity, lastUid]
      )
    }
    return summary
  }

  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = syncMailbox()
      .then(async (result) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'succeeded', {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        return result
      })
      .catch(async (error) => {
        const finishedAtMs = clock()
        await poolInstance.query(
          `UPDATE email_mailbox_state SET last_error_at = NOW(), last_error_code = $2, updated_at = NOW()
           WHERE source_key = $1`,
          [sourceKey, sanitizeMaintenanceErrorCode(error)]
        ).catch(() => {})
        await notifyObserver(observer, 'failed', {
          error,
          result: {},
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        logger?.error?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'MXroute email ingestion failed')
      })
      .finally(() => { activeRun = null })
    return activeRun
  }

  timer = timerApi.setInterval(() => void run(), validated.pollIntervalSeconds * 1000)
  timer?.unref?.()
  void run()
  return async () => {
    stopped = true
    if (timer) timerApi.clearInterval(timer)
    if (reconnectTimer) timerApi.clearTimeout(reconnectTimer)
    if (activeRun) await activeRun
    const client = imap
    imap = null
    try { await client?.logout?.() } catch { try { client?.close?.() } catch {} }
  }
}
