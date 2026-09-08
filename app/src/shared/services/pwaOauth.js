import { apiRequest } from './apiClient.js'

export function isHomeScreenApp(browser = globalThis.window) {
  return Boolean(browser?.navigator?.standalone || browser?.matchMedia?.('(display-mode: standalone)').matches)
}

// No credentials or pending-login payloads are stored in localStorage/sessionStorage.
// A short-lived HttpOnly cookie identifies the initiating app after a process restart.
export function createPwaOauthController({
  request = apiRequest, browser = window, documentRef = document,
  onState = () => {}, onComplete = () => {}, onError = () => {}
} = {}) {
  let timer = null
  let generation = 0
  let pending = false
  let busy = false
  let expiresAt = 0
  let disposed = false
  let completionAttempted = false
  const emptyPost = { method: 'POST', body: '{}', expectedUnauthorized: true }
  const clearTimer = () => { if (timer !== null) browser.clearTimeout(timer); timer = null }
  const schedule = () => {
    clearTimer()
    if (pending && !disposed) timer = browser.setTimeout(() => void check(), 2500)
  }

  async function recoverCompletedSession(current) {
    if (!completionAttempted) return false
    const session = await request('/auth/session', { expectedUnauthorized: true })
    if (disposed || current !== generation || !session.user?.id) return false
    pending = false
    clearTimer()
    onState('complete')
    await onComplete(session)
    return true
  }

  async function check({ restore = false } = {}) {
    if (disposed || busy || (!restore && !pending)) return
    if (documentRef.visibilityState === 'hidden') { schedule(); return }
    const current = generation
    busy = true
    try {
      const result = await request('/auth/oauth/pwa/status', emptyPost)
      if (disposed || current !== generation) return
      if (result.state === 'expired') {
        // Lost completion responses must be reconciled with the real HttpOnly session.
        if (await recoverCompletedSession(current)) return
        const wasPending = pending
        pending = false
        clearTimer()
        onState('idle')
        if (wasPending) onError(new Error('本次 Google 验证已过期，请重新登录。'))
        return
      }
      pending = true
      if (!expiresAt) expiresAt = Date.now() + 600000
      onState('pending')
      if (result.state === 'ready') {
        completionAttempted = true
        const completed = await request('/auth/oauth/pwa/complete', emptyPost)
        if (disposed || current !== generation) return
        if (!completed.user?.id) throw new Error('未能恢复登录，请重试。')
        pending = false
        clearTimer()
        onState('complete')
        await onComplete(completed)
        return
      }
    } catch (error) {
      if (disposed || current !== generation) return
      if ([400, 403, 409].includes(Number(error.status)) || (expiresAt && Date.now() >= expiresAt)) {
        if (await recoverCompletedSession(current).catch(() => false)) return
        pending = false
        clearTimer()
        onState('idle')
        onError(error)
      } else if (pending) {
        onState('reconnecting')
      }
    } finally {
      busy = false
      schedule()
    }
  }

  async function start(provider, returnTo, trustDevice = false) {
    if (!['google', 'wechat'].includes(provider) || pending || disposed) return
    // Open synchronously in the user's gesture, before awaiting the start request.
    const target = `domo_oauth_${browser.crypto.randomUUID().replaceAll('-', '')}`
    const popup = browser.open('about:blank', target)
    if (!popup) throw new Error('登录窗口被拦截，请允许弹出窗口后重试，或使用账号密码。')
    try {
      popup.document.title = '安全登录 · DOMO NAV'
      popup.document.body.textContent = '正在打开身份验证。完成后请返回 DOMO NAV。'
      const result = await request(`/auth/oauth/${provider}/pwa/start`, {
        method: 'POST', expectedUnauthorized: true,
        body: JSON.stringify({ returnTo, trustDevice: trustDevice === true })
      })
      if (disposed) { popup.close(); return }
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.launch)) throw new Error('登录服务暂不可用，请稍后重试。')
      const form = documentRef.createElement('form')
      form.method = 'POST'
      form.action = new URL(`/api/auth/oauth/${provider}/pwa/launch`, browser.location.origin).href
      form.target = target
      form.hidden = true
      const field = documentRef.createElement('input')
      field.name = 'launch'
      field.type = 'hidden'
      field.value = result.launch
      form.append(field)
      documentRef.body.append(form)
      try { form.submit() } finally { field.value = ''; form.remove(); result.launch = '' }
      // Google never receives an opener reference to the original application.
      try { popup.opener = null } catch { /* Browser isolation may have already severed it. */ }
      generation += 1
      completionAttempted = false
      pending = true
      expiresAt = Date.now() + 600000
      onState('pending')
      schedule()
    } catch (error) {
      try { popup.close() } catch { /* The user can close an isolated window. */ }
      await request('/auth/oauth/pwa/cancel', emptyPost).catch(() => {})
      throw error
    }
  }

  async function cancel() {
    generation += 1
    pending = false
    clearTimer()
    // Do not continue to another sign-in until cancellation is acknowledged.
    await request('/auth/oauth/pwa/cancel', emptyPost)
    onState('idle')
  }

  function onVisible() { if (documentRef.visibilityState === 'visible') void check() }
  documentRef.addEventListener('visibilitychange', onVisible)
  return {
    start, check, cancel,
    restore: () => check({ restore: true }),
    dispose() { disposed = true; generation += 1; clearTimer(); documentRef.removeEventListener('visibilitychange', onVisible) }
  }
}
