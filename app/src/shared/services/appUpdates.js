import { assertSafeToReload, confirmVersionReload } from './reloadGuards.js'

export function parseBuildInfo(value) {
  if (!value || value.schemaVersion !== 1
    || typeof value.version !== 'string' || !/^[\w.-]{1,40}$/.test(value.version)
    || typeof value.buildId !== 'string' || !/^[\w.-]{1,100}$/.test(value.buildId)
    || typeof value.builtAt !== 'string' || !Number.isFinite(Date.parse(value.builtAt))
    || !Array.isArray(value.notes) || value.notes.length > 8
    || value.notes.some((note) => typeof note !== 'string' || note.length > 240)) {
    throw new Error('站点版本信息无效，请稍后重试或联系管理员。')
  }
  return { schemaVersion: 1, version: value.version, buildId: value.buildId, builtAt: value.builtAt, notes: [...value.notes] }
}

export function createAppUpdates({
  currentBuild,
  fetchImpl = (...args) => globalThis.fetch(...args),
  confirm = confirmVersionReload,
  guard = assertSafeToReload,
  reload = () => globalThis.window.location.reload(),
  timeoutMs = 8_000
} = {}) {
  const listeners = new Set()
  const state = { current: currentBuild || null, latest: null, status: 'idle', error: '', checkedAt: null }
  let pending = null
  let applying = false
  const snapshot = () => ({ ...state, busy: Boolean(pending) || applying })
  const emit = () => { for (const listener of listeners) listener(snapshot()) }
  async function check() {
    if (pending) return pending
    state.status = 'checking'
    state.error = ''
    const controller = new AbortController()
    let timer
    pending = (async () => {
      try {
        // Separate static request: errors here must not mutate the user session.
        const operation = (async () => {
          const response = await fetchImpl(`/version.json?check=${Date.now()}`, {
            cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
            headers: { Accept: 'application/json' }
          })
          if (!response.ok) throw new Error(`无法检查更新（HTTP ${response.status}），请稍后重试。`)
          if (!(response.headers.get('content-type') || '').includes('application/json')) {
            throw new Error('站点尚未提供有效的版本信息，请稍后重试。')
          }
          const text = await response.text()
          if (text.length > 8_192) throw new Error('站点版本信息过大，已停止检查。')
          return parseBuildInfo(JSON.parse(text))
        })()
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('检查更新超时，请检查网络后重试。')) }, timeoutMs)
        })
        const latest = await Promise.race([operation, deadline])
        if (!state.current) throw new Error('当前构建未包含版本信息，无法比较版本。')
        state.latest = latest
        // A rollback is also a different deployed build; never compare date/version ordering.
        state.status = latest.buildId === state.current.buildId ? 'current' : 'available'
        state.checkedAt = new Date().toISOString()
        return latest
      } catch (error) {
        state.status = 'error'
        state.error = error instanceof SyntaxError ? '站点版本信息无法解析，请稍后重试。' : (error.message || '检查更新失败，请检查网络后重试。')
        return null
      } finally { clearTimeout(timer) }
    })()
    emit()
    try { return await pending } finally { pending = null; emit() }
  }
  async function apply() {
    if (applying) return false
    applying = true
    emit()
    try {
      guard()
      // Revalidate before refreshing: no "update" based on a stale/offline result.
      const latest = await check()
      if (!latest || state.status !== 'available') return false
      if (!confirm()) return false
      guard()
      reload()
      return true
    } catch (error) {
      state.error = error.message || '暂时无法更新，请先保存内容。'
      return false
    } finally { applying = false; emit() }
  }
  return { snapshot, check, apply, subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener) } }
}

export const appUpdates = createAppUpdates({
  currentBuild: typeof __NAV_BUILD_INFO__ === 'undefined' ? null : parseBuildInfo(__NAV_BUILD_INFO__)
})
