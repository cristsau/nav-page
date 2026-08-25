let registration = null
let registrationPromise = null
let applyingUpdate = false
let controllerListenerInstalled = false
const listeners = new Set()
const watchedRegistrations = new WeakSet()
const state = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  registered: false,
  active: false,
  updateReady: false,
  error: ''
}

function emitState() {
  const snapshot = { ...state }
  for (const listener of listeners) listener(snapshot)
}

function watchRegistration(nextRegistration) {
  if (!nextRegistration) return null
  registration = nextRegistration
  state.registered = true
  state.active = Boolean(nextRegistration.active)
  state.updateReady = Boolean(nextRegistration.waiting)
  state.error = ''
  emitState()
  if (watchedRegistrations.has(nextRegistration)) return nextRegistration
  watchedRegistrations.add(nextRegistration)
  nextRegistration.addEventListener('updatefound', () => {
    const worker = nextRegistration.installing
    worker?.addEventListener('statechange', () => {
      state.active = Boolean(nextRegistration.active)
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        state.updateReady = true
      }
      emitState()
    })
  })
  return nextRegistration
}

function pwaError(error, fallback, stage = 'registration') {
  const wrapped = new Error(error?.message || fallback)
  wrapped.name = error?.name || 'Error'
  wrapped.code = String(error?.code || '')
  wrapped.pwaStage = stage
  wrapped.cause = error
  return wrapped
}

function currentClientUrl() {
  return globalThis.location?.href || '/'
}

async function withPwaTimeout(operation, timeoutMs, fallback, stage = 'registration') {
  let timeoutId
  try {
    const pending = Promise.resolve().then(operation)
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(pwaError(null, fallback, stage))
      }, timeoutMs)
    })
    return await Promise.race([pending, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function findExistingRegistration() {
  if (!state.supported || !globalThis.isSecureContext) return null
  const existing = await navigator.serviceWorker.getRegistration(currentClientUrl())
  return existing ? watchRegistration(existing) : null
}

export function waitForActiveRegistration(nextRegistration, timeoutMs = 12_000) {
  if (nextRegistration?.active) {
    state.active = true
    emitState()
    return Promise.resolve(nextRegistration)
  }

  const worker = nextRegistration?.installing || nextRegistration?.waiting
  if (!worker) {
    return Promise.reject(pwaError(
      null,
      'Service Worker 注册存在，但没有可激活的 worker',
      'activation'
    ))
  }

  // A restored iOS Home Screen app can retain a waiting worker without an
  // active controller. Ask that worker to activate before listening; updates
  // with an existing active controller keep the normal explicit-update flow.
  if (!nextRegistration.active && nextRegistration.waiting === worker) {
    worker.postMessage?.({ type: 'SKIP_WAITING' })
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finish()
      reject(pwaError(
        null,
        `Service Worker 在 ${Math.ceil(timeoutMs / 1000)} 秒内没有激活`,
        'activation'
      ))
    }, timeoutMs)
    const finish = () => {
      clearTimeout(timeoutId)
      worker.removeEventListener('statechange', handleStateChange)
    }
    const handleStateChange = () => {
      state.active = Boolean(nextRegistration.active)
      emitState()
      if (nextRegistration.active) {
        finish()
        resolve(nextRegistration)
      } else if (worker.state === 'redundant') {
        finish()
        reject(pwaError(
          null,
          'Service Worker 安装已失效，请修复当前站点的通知环境',
          'activation'
        ))
      }
    }
    worker.addEventListener('statechange', handleStateChange)
    handleStateChange()
  })
}

function ensureControllerListener() {
  if (controllerListenerInstalled || !state.supported) return
  controllerListenerInstalled = true
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applyingUpdate) return
    applyingUpdate = false
    window.location.reload()
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
  ensureControllerListener()
  if (registration?.active) return registration
  if (registrationPromise) return registrationPromise

  registrationPromise = (async () => {
    const existing = await withPwaTimeout(
      findExistingRegistration,
      4_000,
      '读取现有 Service Worker 超时'
    )
    const nextRegistration = existing || watchRegistration(
      await withPwaTimeout(
        () => navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none'
        }),
        10_000,
        '创建 Service Worker 注册超时'
      )
    )
    const activeRegistration = await waitForActiveRegistration(nextRegistration, 10_000)

    // Safari/iOS can leave update() pending while the active registration is
    // already usable. Keep the update check detached from notification setup.
    void activeRegistration.update().catch((error) => {
      state.error = error.message || 'Service Worker 更新检查失败'
      emitState()
    })
    return activeRegistration
  })()

  try {
    return await registrationPromise
  } catch (error) {
    const wrapped = pwaError(error, 'Service Worker 注册失败', error?.pwaStage || 'registration')
    state.error = wrapped.message
    state.active = false
    emitState()
    throw wrapped
  } finally {
    registrationPromise = null
  }
}

export async function getPwaRegistration() {
  if (registration?.active) return registration
  return registerPwa()
}

export async function inspectPwaRegistration() {
  if (registration?.active) return registration
  const existing = await withPwaTimeout(
    findExistingRegistration,
    6_000,
    '检查 Service Worker 状态超时',
    'inspection'
  )
  return existing?.active ? existing : null
}

export async function repairPwaRegistration() {
  if (!state.supported || !globalThis.isSecureContext) return false
  const registrations = await withPwaTimeout(
    () => navigator.serviceWorker.getRegistrations(),
    8_000,
    '读取本站 Service Worker 列表超时',
    'repair'
  )
  const currentOrigin = globalThis.location?.origin || ''
  const matching = registrations.filter((item) => {
    try {
      return new URL(item.scope).origin === currentOrigin
    } catch {
      return false
    }
  })
  await withPwaTimeout(
    () => Promise.all(matching.map((item) => item.unregister())),
    8_000,
    '清理本站旧 Service Worker 超时',
    'repair'
  )
  if (typeof caches !== 'undefined') {
    const keys = await withPwaTimeout(
      () => caches.keys(),
      5_000,
      '读取本站离线缓存超时',
      'repair'
    )
    await withPwaTimeout(
      () => Promise.all(
        keys.filter((key) => key.startsWith('domonav-shell-')).map((key) => caches.delete(key))
      ),
      5_000,
      '清理本站离线缓存超时',
      'repair'
    )
  }
  registration = null
  registrationPromise = null
  state.registered = false
  state.active = false
  state.updateReady = false
  state.error = ''
  emitState()
  return true
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
