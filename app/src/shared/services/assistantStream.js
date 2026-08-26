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

export async function consumeAssistantSseBody(body, { onEvent = () => {} } = {}) {
  if (!body) throw new Error('当前浏览器不支持流式回答')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let receivedDone = false
  let completed = false

  const dispatch = (parsed) => {
    if (!parsed) return
    onEvent(parsed.event, parsed.payload)
    if (parsed.event === 'error') {
      throw new Error(parsed.payload?.error || '助理回答失败')
    }
    if (parsed.event === 'done') receivedDone = true
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
    if (!receivedDone) {
      throw new Error('助理响应流不完整，可重试本次请求')
    }
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
  }
}
