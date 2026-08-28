import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { config } from '../config.js'
import { validateImapConfig } from './emailIngestScheduler.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { resolveImapAuth } from './emailOauth2.js'
export {
  decorateIncomingAttachmentMetadata,
  normalizeIncomingAttachmentMetadata,
  safeAttachmentDownloadName
} from './emailIncomingAttachmentMetadata.js'
import { normalizeIncomingAttachmentMetadata } from './emailIncomingAttachmentMetadata.js'

export const EMAIL_INCOMING_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
export const EMAIL_INCOMING_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

function safeSize(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function normalizedRemoteInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4_294_967_295) {
    throw Object.assign(new Error(`${label} is invalid`), { code: 'EMAIL_REMOTE_ID_INVALID' })
  }
  return parsed
}

function closeImapClient(client) {
  if (!client) return Promise.resolve()
  return (async () => {
    try {
      if (client.usable) await client.logout()
      else client.close?.()
    } catch {
      try { client.close?.() } catch {}
    }
  })()
}

export async function fetchIncomingAttachment(
  location,
  attachmentId,
  runtimeConfig = config,
  {
    ImapClient = ImapFlow,
    parseMessage = simpleParser,
    readSecret = readOwnerSecretFile,
    assertHost = assertSafeOutboundHost
  } = {}
) {
  const expectedAttachmentId = String(attachmentId || '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(expectedAttachmentId)) {
    throw Object.assign(new Error('Email attachment identifier is invalid'), {
      code: 'EMAIL_ATTACHMENT_ID_INVALID'
    })
  }
  const folderPath = String(location?.folder_path || location?.folderPath || '')
  if (!folderPath || /[\r\n\u0000]/.test(folderPath)) {
    throw Object.assign(new Error('Email folder path is invalid'), { code: 'EMAIL_FOLDER_INVALID' })
  }
  const uid = normalizedRemoteInteger(location?.uid, 'IMAP UID')
  const uidValidity = normalizedRemoteInteger(location?.uid_validity ?? location?.uidValidity, 'IMAP UIDVALIDITY')
  const sizeBytes = safeSize(location?.size_bytes ?? location?.sizeBytes)
  if (!sizeBytes || sizeBytes > EMAIL_INCOMING_DOWNLOAD_MAX_BYTES) {
    throw Object.assign(new Error('Email source is too large for on-demand attachment download'), {
      code: 'EMAIL_SOURCE_TOO_LARGE'
    })
  }

  validateImapConfig(runtimeConfig)
  await assertHost(runtimeConfig.imapHost, { label: 'IMAP ' })
  const auth = await resolveImapAuth(runtimeConfig, { readSecretImpl: readSecret })
  const client = new ImapClient({
    host: runtimeConfig.imapHost,
    port: Number(runtimeConfig.imapPort),
    secure: true,
    auth,
    disableAutoIdle: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false
  })
  let lock
  let source
  let parsed
  try {
    await client.connect()
    lock = await client.getMailboxLock(folderPath, { readOnly: true })
    const selectedUidValidity = Number(client.mailbox?.uidValidity)
    if (selectedUidValidity !== uidValidity) {
      throw Object.assign(new Error('The remote mailbox generation changed; refresh the mailbox and retry'), {
        code: 'EMAIL_UIDVALIDITY_CHANGED'
      })
    }
    const remote = await client.fetchOne(
      uid,
      { source: { start: 0, maxLength: EMAIL_INCOMING_DOWNLOAD_MAX_BYTES + 1 } },
      { uid: true }
    )
    source = Buffer.isBuffer(remote?.source) ? remote.source : Buffer.from(remote?.source || '')
    if (!source.length || source.length > EMAIL_INCOMING_DOWNLOAD_MAX_BYTES || source.length < sizeBytes) {
      throw Object.assign(new Error('The remote email source is incomplete or too large'), {
        code: 'EMAIL_SOURCE_INCOMPLETE'
      })
    }
    parsed = await parseMessage(source, { skipHtmlToText: true, skipTextToHtml: true })
    const candidates = (Array.isArray(parsed?.attachments) ? parsed.attachments : [])
      .map((attachment, ordinal) => ({
        attachment,
        metadata: normalizeIncomingAttachmentMetadata(attachment, ordinal)
      }))
    const selected = candidates.find(({ metadata }) => metadata.id === expectedAttachmentId)
    if (!selected) {
      throw Object.assign(new Error('The attachment no longer matches the cached email metadata'), {
        code: 'EMAIL_ATTACHMENT_NOT_FOUND'
      })
    }
    if (!Buffer.isBuffer(selected.attachment.content)) {
      throw Object.assign(new Error('The attachment content is unavailable'), {
        code: 'EMAIL_ATTACHMENT_CONTENT_UNAVAILABLE'
      })
    }
    if (!selected.attachment.content.length || selected.attachment.content.length > EMAIL_INCOMING_ATTACHMENT_MAX_BYTES) {
      throw Object.assign(new Error('The attachment is too large to download'), {
        code: 'EMAIL_ATTACHMENT_TOO_LARGE'
      })
    }
    const content = Buffer.from(selected.attachment.content)
    return { ...selected.metadata, size: content.length, content }
  } finally {
    try { lock?.release?.() } catch {}
    if (parsed?.attachments) {
      for (const attachment of parsed.attachments) {
        if (Buffer.isBuffer(attachment?.content)) attachment.content.fill(0)
      }
    }
    if (Buffer.isBuffer(source)) source.fill(0)
    await closeImapClient(client)
  }
}
