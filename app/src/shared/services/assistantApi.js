import {
  apiRawRequest,
  apiRequest as request
} from '@/shared/services/apiClient'

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

export async function createAssistantConversation(title = '') {
  return request('/assistant/conversations', {
    method: 'POST',
    body: JSON.stringify({ title })
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

function parseSseFrame(frame) {
  let event = 'message'
  const data = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  try {
    return { event, payload: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}

export async function streamAssistantMessage({
  conversationId = '',
  query,
  signal,
  onEvent = () => {}
}) {
  const response = await apiRawRequest('/assistant/chat/stream', {
    method: 'POST',
    body: JSON.stringify({ conversationId: conversationId || undefined, query }),
    signal
  })
  if (!response.body) throw new Error('当前浏览器不支持流式回答')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false

  const dispatch = (parsed) => {
    if (!parsed) return
    onEvent(parsed.event, parsed.payload)
    if (parsed.event === 'error') {
      throw new Error(parsed.payload?.error || '助理回答失败')
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) dispatch(parseSseFrame(frame))
      if (done) break
    }
    if (buffer.trim()) dispatch(parseSseFrame(buffer))
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
  }
}
