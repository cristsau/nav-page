import {
  apiRawRequest,
  apiRequest as request
} from '@/shared/services/apiClient'
import { consumeAssistantSseBody } from '@/shared/services/assistantStream'

export async function queryWorkspaceAssistant(query) {
  return request('/assistant/query', {
    method: 'POST',
    body: JSON.stringify({ query })
  })
}

export async function fetchAssistantConversations(search = '') {
  const params = new URLSearchParams()
  if (String(search || '').trim()) params.set('search', String(search).trim())
  const suffix = params.size ? `?${params}` : ''
  return request(`/assistant/conversations${suffix}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function createAssistantConversation(title = '', preferences = {}) {
  return request('/assistant/conversations', {
    method: 'POST',
    body: JSON.stringify({ title, ...preferences })
  })
}

export async function fetchAssistantConversation(conversationId) {
  return request(`/assistant/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function deleteAssistantConversation(conversationId) {
  return request(`/assistant/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE'
  })
}

function assistantActionRequest(operationId, action) {
  const id = String(operationId || '').trim()
  if (!id) throw new Error('助理操作 ID 缺失')
  return request(`/assistant/actions/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({})
  })
}

export function confirmAssistantAction(operationId) {
  return assistantActionRequest(operationId, 'confirm')
}

export function cancelAssistantAction(operationId) {
  return assistantActionRequest(operationId, 'cancel')
}

export function undoAssistantAction(operationId) {
  return assistantActionRequest(operationId, 'undo')
}

export async function updateAssistantConversationPreferences(
  conversationId,
  preferences
) {
  return request(
    `/assistant/conversations/${encodeURIComponent(conversationId)}/preferences`,
    {
      method: 'PATCH',
      body: JSON.stringify(preferences)
    }
  )
}

export async function streamAssistantMessage({
  conversationId = '',
  query,
  modelMode = 'latest',
  model = '',
  reasoningEffort = 'low',
  operationId,
  signal,
  onEvent = () => {}
}) {
  const requestOperationId = String(operationId || '').trim()
  if (!requestOperationId) throw new Error('助理操作请求 ID 缺失')
  let timeZone = 'Asia/Shanghai'
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone
  } catch {
    // Keep the server-supported default when the browser omits a time zone.
  }
  const response = await apiRawRequest('/assistant/chat/stream', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: conversationId || undefined,
      query,
      modelMode,
      ...(modelMode === 'pinned' && model ? { model } : {}),
      reasoningEffort,
      operationId: requestOperationId,
      timeZone
    }),
    signal
  })
  await consumeAssistantSseBody(response.body, { onEvent })
}
