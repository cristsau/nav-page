import {
  createRegistrationGeneration,
  isRootServiceWorkerScope
} from './pwaRegistrationState.js'

let registration = null
let registrationPromise = null
let repairPromise = null
let applyingUpdate = false
let controllerListenerInstalled = false
const ACTIVATION_POLL_INTERVAL_MS = 200
const ACTIVATION_REFRESH_INTERVAL_MS = 1_000
const listeners = new Set()
const watchedRegistrationGenerations = new WeakMap()
const registrationGeneration = createRegistrationGeneration()
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

function staleRegistrationError() {
  const error = pwaError(
    null,
    'Service Worker 注册状态已更新，请重试',
    'registration'
  )
  error.code = 'PWA_REGISTRATION_STALE'
  return error
}

function assertCurrentGeneration(generation) {
  if (!registrationGeneration.isCurrent(generation)) throw staleRegistrationError()
}

function watchRegistration(nextRegistration, generation = registrationGeneration.current()) {
  if (!nextRegistration) return null
  assertCurrentGeneration(generation)
  registration = nextRegistration
  state.registered = true
  state.active = Boolean(nextRegistration.active)
  state.updateReady = Boolean(nextRegistration.waiting)
  state.error = ''
  emitState()
  if (watchedRegistrationGenerations.get(nextRegistration) === generation) return nextRegistration
  watchedRegistrationGenerations.set(nextRegistration, generation)
  nextRegistration.addEventListener('updatefound', () => {
    if (!registrationGeneration.isCurrent(generation)) return
    const worker = nextRegistration.installing
    worker?.addEventListener('statechange', () => {
      if (!registrationGeneration.isCurrent(generation)) return
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

async function findExistingRegistration(generation = registrationGeneration.current()) {
  if (!state.supported || !globalThis.isSecureContext) return null
  const existing = await navigator.serviceWorker.getRegistration(currentClientUrl())
  assertCurrentGeneration(generation)
  return existing || null
}

export function waitForActiveRegistration(
  nextRegistration,
  timeoutMs = 12_000,
  generation = registrationGeneration.current()
) {
  if (!registrationGeneration.isCurrent(generation)) {
    return Promise.reject(staleRegistrationError())
  }
  if (nextRegistration?.active) {
    state.active = true
    emitState()
    return Promise.resolve(nextRegistration)
  }

  let observedWorker = nextRegistration?.installing || nextRegistration?.waiting || null
  let activationRequestedFor = null
  const requestActivationIfWaiting = () => {
    const waitingWorker = nextRegistration?.waiting
    if (
      !waitingWorker
      || nextRegistration.active
      || activationRequestedFor === waitingWorker
    ) return
    activationRequestedFor = waitingWorker
    waitingWorker.postMessage?.({ type: 'SKIP_WAITING' })
  }

  // A restored iOS Home Screen app can retain a waiting worker without an
  // active controller. Poll as well as listening for statechange because
  // WebKit can omit or delay that event while the registration becomes active.
  requestActivationIfWaiting()

  return new Promise((resolve, reject) => {
    let settled = false
    let refreshPending = false
    let lastRefreshAt = 0
    const timeoutId = setTimeout(() => {
      finish()
      if (!registrationGeneration.isCurrent(generation)) {
        reject(staleRegistrationError())
        return
      }
      reject(pwaError(
        null,
        `Service Worker 在 ${Math.ceil(timeoutMs / 1000)} 秒内没有激活`,
        'activation'
      ))
    }, timeoutMs)
    const pollId = setInterval(
      () => checkActivation(),
      Math.min(ACTIVATION_POLL_INTERVAL_MS, Math.max(10, Math.floor(timeoutMs / 4)))
    )
    const detachWorker = () => {
      observedWorker?.removeEventListener?.('statechange', handleStateChange)
    }
    const attachCurrentWorker = () => {
      const currentWorker = nextRegistration?.installing || nextRegistration?.waiting || null
      if (currentWorker === observedWorker) return
      detachWorker()
      observedWorker = currentWorker
      observedWorker?.addEventListener?.('statechange', handleStateChange)
    }
    const finish = () => {
      if (settled) return false
      settled = true
      clearTimeout(timeoutId)
      clearInterval(pollId)
      detachWorker()
      return true
    }
    const refreshRegistration = async () => {
      if (
        refreshPending
        || settled
        || typeof navigator === 'undefined'
        || !navigator.serviceWorker?.getRegistration
      ) return
      refreshPending = true
      try {
        const refreshed = await navigator.serviceWorker.getRegistration(currentClientUrl())
        if (settled || !registrationGeneration.isCurrent(generation)) return
        if (refreshed?.active && finish()) {
          state.active = true
          emitState()
          watchRegistration(refreshed, generation)
          resolve(refreshed)
        }
      } catch {
        // Keep the bounded activation wait alive. The original registration
        // may still become active even if this refresh attempt failed.
      } finally {
        refreshPending = false
      }
    }
    const checkActivation = () => {
      if (settled) return
      if (!registrationGeneration.isCurrent(generation)) {
        if (finish()) reject(staleRegistrationError())
        return
      }
      attachCurrentWorker()
      state.active = Boolean(nextRegistration.active)
      emitState()
      requestActivationIfWaiting()
      if (nextRegistration.active) {
        if (finish()) resolve(nextRegistration)
        return
      }
      if (observedWorker?.state === 'redundant') {
        if (finish()) reject(pwaError(
          null,
          'Service Worker 安装已失效，请修复当前站点的通知环境',
          'activation'
        ))
        return
      }
      const now = Date.now()
      if (now - lastRefreshAt >= ACTIVATION_REFRESH_INTERVAL_MS) {
        lastRefreshAt = now
        void refreshRegistration()
      }
    }
    const handleStateChange = () => checkActivation()
    observedWorker?.addEventListener?.('statechange', handleStateChange)
    checkActivation()
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
  if (repairPromise) {
    throw pwaError(null, 'Service Worker 正在修复，请稍后重试', 'repair')
  }

  const generation = registrationGeneration.current()
  const pendingRegistration = (async () => {
    const existing = await withPwaTimeout(
      () => findExistingRegistration(generation),
      4_000,
      '读取现有 Service Worker 超时'
    )
    assertCurrentGeneration(generation)
    const nextRegistration = existing
      ? watchRegistration(existing, generation)
      : watchRegistration(
        await withPwaTimeout(
          () => navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none'
          }),
          10_000,
          '创建 Service Worker 注册超时'
        ),
        generation
      )
    assertCurrentGeneration(generation)

    // Kick WebKit's registration/update state machine before waiting. Do not
    // await update(): Safari can leave the promise pending while activation is
    // already progressing, so the bounded poll below remains authoritative.
    void nextRegistration.update().catch(() => {})
    const activeRegistration = await waitForActiveRegistration(nextRegistration, 10_000, generation)
    assertCurrentGeneration(generation)

    // Safari/iOS can leave update() pending while the active registration is
    // already usable. Keep the update check detached from notification setup.
    void activeRegistration.update().catch((error) => {
      if (!registrationGeneration.isCurrent(generation)) return
      state.error = error.message || 'Service Worker 更新检查失败'
      emitState()
    })
    return activeRegistration
  })()
  registrationPromise = pendingRegistration

  try {
    return await pendingRegistration
  } catch (error) {
    const wrapped = pwaError(error, 'Service Worker 注册失败', error?.pwaStage || 'registration')
    if (registrationGeneration.isCurrent(generation)) {
      registrationGeneration.invalidate()
      registration = null
      state.registered = false
      state.error = wrapped.message
      state.active = false
      emitState()
    }
    throw wrapped
  } finally {
    if (registrationPromise === pendingRegistration) registrationPromise = null
  }
}

export async function getPwaRegistration() {
  if (registration?.active) return registration
  return registerPwa()
}

export function getActivePwaRegistration() {
  return registration?.active ? registration : null
}

export async function inspectPwaRegistration() {
  if (registration?.active) return registration
  const generation = registrationGeneration.current()
  const existing = await withPwaTimeout(
    () => findExistingRegistration(generation),
    6_000,
    '检查 Service Worker 状态超时',
    'inspection'
  )
  assertCurrentGeneration(generation)
  const watched = existing ? watchRegistration(existing, generation) : null
  return watched?.active ? watched : null
}

export async function repairPwaRegistration() {
  if (!state.supported || !globalThis.isSecureContext) return false
  if (repairPromise) return repairPromise

  // Invalidate first so any registration/getRegistration promise that resolves
  // after repair starts cannot repopulate the repaired in-memory state.
  registrationGeneration.invalidate()
  registration = null
  registrationPromise = null
  state.registered = false
  state.active = false
  state.updateReady = false
  state.error = ''
  emitState()

  const unregisterRootScope = async () => {
    const registrations = await withPwaTimeout(
      () => navigator.serviceWorker.getRegistrations(),
      8_000,
      '读取本站 Service Worker 列表超时',
      'repair'
    )
    const origin = globalThis.location?.origin || currentClientUrl()
    const matching = registrations.filter((item) => isRootServiceWorkerScope(item.scope, origin))
    await withPwaTimeout(
      () => Promise.all(matching.map((item) => item.unregister())),
      8_000,
      '清理本站旧 Service Worker 超时',
      'repair'
    )
  }

  const pendingRepair = (async () => {
    await unregisterRootScope()
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
    // Re-read once after cache cleanup to catch a timed-out registration call
    // that completed while repair was already in progress.
    await unregisterRootScope()

    // Repair is complete only after a fresh root registration is active. A
    // reload alone is insufficient on iOS because the old registration can
    // remain detached from the Home Screen web app process.
    const generation = registrationGeneration.current()
    const nextRegistration = watchRegistration(
      await withPwaTimeout(
        () => navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none'
        }),
        10_000,
        '重新创建 Service Worker 注册超时',
        'repair'
      ),
      generation
    )
    void nextRegistration.update().catch(() => {})
    await waitForActiveRegistration(nextRegistration, 12_000, generation)
    return true
  })()
  repairPromise = pendingRepair
  try {
    return await pendingRepair
  } finally {
    if (repairPromise === pendingRepair) repairPromise = null
  }
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
