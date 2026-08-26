function parseFrame(frame) {
  let event = 'message'
  let id = ''
  const data = []
  for (const line of String(frame || '').split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('id:')) id = line.slice(3).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  try {
    return { event, id, payload: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}

export async function consumeMailSseBody(body, {
  signal,
  onEvent = () => {}
} = {}) {
  if (!body) throw new Error('当前浏览器不支持邮件实时刷新')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const abort = () => reader.cancel().catch(() => {})
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''
      for (const frame of frames) {
        const parsed = parseFrame(frame)
        if (parsed) onEvent(parsed)
      }
      if (done) break
    }
    if (!signal?.aborted && buffer.trim()) {
      const parsed = parseFrame(buffer)
      if (parsed) onEvent(parsed)
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
  }
}

export function waitForMailReconnect(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve(true)
    }, delayMs)
    const cancel = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
