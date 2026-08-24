let registration = null
let applyingUpdate = false
const listeners = new Set()
const state = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  registered: false,
  updateReady: false,
  error: ''
}

function emitState() {
  const snapshot = { ...state }
  for (const listener of listeners) listener(snapshot)
}

function watchRegistration(nextRegistration) {
  registration = nextRegistration
  state.registered = true
  state.updateReady = Boolean(registration.waiting)
  emitState()
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        state.updateReady = true
        emitState()
      }
    })
  })
}

export function getPwaState() {
  return { ...state }
}

export function subscribePwaState(listener) {
  listeners.add(listener)
  listener(getPwaState())
  return () => listeners.delete(listener)
}

export async function registerPwa() {
  if (!state.supported || !globalThis.isSecureContext || !import.meta.env?.PROD) return null
  try {
    watchRegistration(await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none'
    }))
    await registration.update()
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!applyingUpdate) return
      applyingUpdate = false
      window.location.reload()
    })
    return registration
  } catch (error) {
    state.error = error.message || 'Service Worker 注册失败'
    emitState()
    return null
  }
}

export async function getPwaRegistration() {
  if (registration) return registration
  await registerPwa()
  if (registration) return registration
  if (state.supported && globalThis.isSecureContext) {
    return navigator.serviceWorker.ready
  }
  return null
}

export async function checkPwaUpdate() {
  if (!registration) return false
  await registration.update()
  state.updateReady = Boolean(registration.waiting)
  emitState()
  return state.updateReady
}

export function applyPwaUpdate() {
  if (!registration?.waiting) return false
  applyingUpdate = true
  registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  return true
}
