import {
  apiRawRequest,
  apiRequest as request
} from '@/shared/services/apiClient'

function requiredId(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new TypeError(`${label} is required`)
  return encodeURIComponent(normalized)
}

export function fetchEmailStatus() {
  return request('/email/status', { method: 'GET', cache: 'no-store' })
}

export async function fetchEmailEvents({ tier = 0, limit = 40 } = {}) {
  const query = new URLSearchParams({ tier: String(tier || 0), limit: String(limit) })
  const payload = await request(`/email/events?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store'
  })
  return payload.emails || []
}

export async function fetchEmailEvent(emailEventId) {
  const payload = await request(`/email/events/${encodeURIComponent(emailEventId)}`, {
    method: 'GET',
    cache: 'no-store'
  })
  return payload.email
}

export function fetchEmailAccounts() {
  return request('/email/accounts', { method: 'GET', cache: 'no-store' })
}

export function requestEmailAccountSync(accountId) {
  return request(`/email/accounts/${requiredId(accountId, 'Email account id')}/sync`, {
    method: 'POST',
    body: JSON.stringify({})
  })
}

export function fetchEmailAccountSyncStatus(accountId) {
  return request(`/email/accounts/${requiredId(accountId, 'Email account id')}/sync-status`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export function fetchEmailFolders(accountId) {
  return request(`/email/accounts/${requiredId(accountId, 'Email account id')}/folders`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export function fetchEmailMessages({
  accountId,
  folderId,
  cursor = '',
  limit = 40,
  q = '',
  filter = 'all'
} = {}) {
  const query = new URLSearchParams({
    folderId: String(folderId || ''),
    limit: String(limit)
  })
  if (String(cursor || '').trim()) query.set('cursor', String(cursor).trim())
  if (String(q || '').trim()) query.set('q', String(q).trim())
  if (String(filter || '').trim() && String(filter).trim() !== 'all') {
    query.set('filter', String(filter).trim())
  }
  return request(
    `/email/accounts/${requiredId(accountId, 'Email account id')}/messages?${query.toString()}`,
    { method: 'GET', cache: 'no-store' }
  )
}

export function fetchEmailMessage({ accountId, locationId, folderId } = {}) {
  const query = new URLSearchParams({ folderId: String(folderId || '') })
  return request(
    `/email/accounts/${requiredId(accountId, 'Email account id')}/messages/${requiredId(locationId, 'Email location id')}?${query.toString()}`,
    { method: 'GET', cache: 'no-store' }
  )
}

export function createEmailMessageCommand({
  accountId,
  locationId,
  action,
  targetFolderId = '',
  idempotencyKey,
  expected = {},
  confirm = ''
} = {}) {
  const payload = {
    action: String(action || '').trim(),
    idempotencyKey: String(idempotencyKey || '').trim(),
    expected: {
      uidValidity: expected?.uidValidity == null ? null : String(expected.uidValidity),
      modseq: expected?.modseq == null ? null : String(expected.modseq),
      seen: expected?.seen === true,
      flagged: expected?.flagged === true,
      deleted: expected?.deleted === true
    }
  }
  if (String(targetFolderId || '').trim()) payload.targetFolderId = String(targetFolderId).trim()
  if (String(confirm || '').trim()) payload.confirm = String(confirm).trim()
  return request(
    `/email/accounts/${requiredId(accountId, 'Email account id')}/messages/${requiredId(locationId, 'Email location id')}/commands`,
    {
      method: 'POST',
      body: JSON.stringify(payload)
    }
  )
}

export function fetchEmailMessageCommand(commandId) {
  return request(`/email/commands/${requiredId(commandId, 'Email command id')}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export function undoEmailMessageCommand(commandId) {
  return request(`/email/commands/${requiredId(commandId, 'Email command id')}/undo`, {
    method: 'POST',
    body: JSON.stringify({})
  })
}

export function requestEmailAi(messageId, {
  action,
  instruction = '',
  language = '',
  scope = '',
  tone = '',
  length = ''
} = {}) {
  const payload = { action: String(action || '').trim() }
  const optionalFields = {
    instruction: String(instruction || '').trim(),
    language: String(language || '').trim(),
    scope: String(scope || '').trim(),
    tone: String(tone || '').trim(),
    length: String(length || '').trim()
  }
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value) payload[key] = value
  }
  return request(`/email/messages/${requiredId(messageId, 'Email message id')}/ai`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function searchEmailAi({ search = '', question = '', answer = true } = {}) {
  return request('/email/ai/search', {
    method: 'POST',
    body: JSON.stringify({
      search: String(search || '').trim(),
      question: String(question || '').trim(),
      answer: answer !== false
    })
  })
}

export function createEmailAiProposal(messageId, {
  kind,
  instruction = '',
  tone = '',
  length = ''
} = {}) {
  const payload = { kind: String(kind || '').trim() }
  const optionalFields = {
    instruction: String(instruction || '').trim(),
    tone: String(tone || '').trim(),
    length: String(length || '').trim()
  }
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value) payload[key] = value
  }
  return request(`/email/messages/${requiredId(messageId, 'Email message id')}/ai/proposals`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function confirmEmailAiProposal(messageId, proposal = {}) {
  const payload = {
    kind: String(proposal.kind || '').trim(),
    params: proposal.params,
    operationId: String(proposal.operationId || '').trim(),
    confirmationToken: String(proposal.confirmationToken || '').trim()
  }
  return request(`/email/messages/${requiredId(messageId, 'Email message id')}/ai/confirm`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

// Notification rule contract (implemented by the server-side mail rules module):
// GET    /email/notification-rules
// POST   /email/notification-rules
// PATCH  /email/notification-rules/:id
// DELETE /email/notification-rules/:id
// POST   /email/notification-rules/preview
// The UI never persists a raw match value locally; it derives the current
// conversation/sender/domain/category only when the user previews or saves.
export function fetchEmailNotificationRules({ accountId = '' } = {}) {
  const query = new URLSearchParams()
  if (String(accountId || '').trim()) query.set('accountId', String(accountId).trim())
  const encodedQuery = query.toString()
  const suffix = encodedQuery ? `?${encodedQuery}` : ''
  return request(`/email/notification-rules${suffix}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export function previewEmailNotificationRule(payload = {}) {
  return request('/email/notification-rules/preview', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function createEmailNotificationRule(payload = {}) {
  return request('/email/notification-rules', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function updateEmailNotificationRule(ruleId, payload = {}) {
  return request(`/email/notification-rules/${requiredId(ruleId, 'Email notification rule id')}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  })
}

export function deleteEmailNotificationRule(ruleId) {
  return request(`/email/notification-rules/${requiredId(ruleId, 'Email notification rule id')}`, {
    method: 'DELETE'
  })
}

export function createEmailDraft(payload = {}) {
  return request('/email/drafts', {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

export function fetchEmailDraft(draftId) {
  return request(`/email/drafts/${requiredId(draftId, 'Email draft id')}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export function uploadEmailDraftAttachment(draftId, file) {
  if (!(file instanceof Blob)) {
    throw new TypeError('Attachment file is required')
  }
  const query = new URLSearchParams({
    filename: String(file.name || 'attachment').trim() || 'attachment',
    contentType: String(file.type || 'application/octet-stream').trim() || 'application/octet-stream'
  })
  return request(
    `/email/drafts/${requiredId(draftId, 'Email draft id')}/attachments?${query.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }
  )
}

export function deleteEmailDraftAttachment(draftId, attachmentId) {
  return request(
    `/email/drafts/${requiredId(draftId, 'Email draft id')}/attachments/${requiredId(attachmentId, 'Email attachment id')}`,
    { method: 'DELETE' }
  )
}

function responseFilename(response, fallback = 'attachment') {
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim())
    } catch {
      return encoded.trim()
    }
  }
  return (
    disposition.match(/filename="([^"]+)"/i)?.[1]
    || disposition.match(/filename=([^;]+)/i)?.[1]
    || fallback
  ).trim()
}

export async function downloadEmailAttachment({
  accountId,
  locationId,
  attachmentId,
  folderId,
  filename = 'attachment'
} = {}) {
  const query = new URLSearchParams({ folderId: String(folderId || '') })
  const response = await apiRawRequest(
    `/email/accounts/${requiredId(accountId, 'Email account id')}/messages/${requiredId(locationId, 'Email location id')}/attachments/${requiredId(attachmentId, 'Email attachment id')}?${query.toString()}`,
    {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream' }
    }
  )
  return {
    blob: await response.blob(),
    filename: responseFilename(response, filename)
  }
}

export function translateEmailAttachment({
  accountId,
  locationId,
  attachmentId,
  folderId,
  language = 'zh-CN'
} = {}) {
  return request(
    `/email/accounts/${requiredId(accountId, 'Email account id')}/messages/${requiredId(locationId, 'Email location id')}/attachments/${requiredId(attachmentId, 'Email attachment id')}/ai`,
    {
      method: 'POST',
      body: JSON.stringify({
        action: 'translate',
        folderId: requiredId(folderId, 'Email folder id'),
        language: String(language || 'zh-CN').trim() || 'zh-CN'
      })
    }
  )
}

export function confirmEmailDraft(draftId, contentHash) {
  return request(`/email/drafts/${requiredId(draftId, 'Email draft id')}/send`, {
    method: 'POST',
    body: JSON.stringify({
      confirm: true,
      contentHash: String(contentHash || '').trim()
    })
  })
}

export function openEmailEventStream({ accountId, lastEventId = '', signal } = {}) {
  const query = new URLSearchParams({ accountId: String(accountId || '') })
  const headers = { Accept: 'text/event-stream' }
  if (String(lastEventId || '').trim()) {
    headers['Last-Event-ID'] = String(lastEventId).trim()
  }
  return apiRawRequest(`/email/stream?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store',
    headers,
    signal
  })
}

export function fetchAdminMailStatus() {
  return request('/admin/mail/status', { method: 'GET', cache: 'no-store' })
}

export function queueAdminMailTest(recipient) {
  return request('/admin/mail/test', {
    method: 'POST',
    body: JSON.stringify({ recipient })
  })
}
