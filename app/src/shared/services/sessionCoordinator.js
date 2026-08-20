export const DEFAULT_SESSION_REVALIDATE_INTERVAL_MS = 5 * 60 * 1000

function normalizeSession(value) {
  return value && typeof value === 'object' ? value : null
}

export function createSessionCoordinator({
  resolveSession,
  readCachedSession,
  commitSession,
  now = () => Date.now(),
  revalidateIntervalMs = DEFAULT_SESSION_REVALIDATE_INTERVAL_MS
}) {
  if (typeof resolveSession !== 'function') {
    throw new TypeError('resolveSession must be a function')
  }
  if (typeof readCachedSession !== 'function') {
    throw new TypeError('readCachedSession must be a function')
  }
  if (typeof commitSession !== 'function') {
    throw new TypeError('commitSession must be a function')
  }

  const intervalMs = Number.isFinite(revalidateIntervalMs) && revalidateIntervalMs >= 0
    ? revalidateIntervalMs
    : DEFAULT_SESSION_REVALIDATE_INTERVAL_MS

  let initialized = false
  let inFlight = null
  let generation = 0
  let lastValidatedAt = 0

  function cachedSession() {
    return normalizeSession(readCachedSession())
  }

  function startResolution() {
    if (inFlight) return inFlight

    const requestGeneration = generation
    let flight
    flight = Promise.resolve()
      .then(() => resolveSession())
      .then((resolved) => {
        if (requestGeneration !== generation) {
          return cachedSession()
        }

        const session = normalizeSession(resolved)
        commitSession(session)
        initialized = true
        lastValidatedAt = now()
        return session
      })
      .catch((error) => {
        if (requestGeneration !== generation) {
          return cachedSession()
        }

        if (Number(error?.status) === 401) {
          commitSession(null)
          initialized = true
          lastValidatedAt = now()
          return null
        }

        throw error
      })
      .finally(() => {
        if (inFlight === flight) {
          inFlight = null
        }
      })

    inFlight = flight
    return flight
  }

  function initialize() {
    if (initialized) return Promise.resolve(cachedSession())
    return startResolution()
  }

  function revalidate({ force = false } = {}) {
    if (inFlight) return inFlight
    if (!initialized) return initialize()
    if (!force && now() - lastValidatedAt < intervalMs) {
      return Promise.resolve(cachedSession())
    }
    return startResolution()
  }

  function accept(session) {
    generation += 1
    inFlight = null
    const normalized = normalizeSession(session)
    commitSession(normalized)
    initialized = true
    lastValidatedAt = now()
    return normalized
  }

  function invalidate({ resolved = true } = {}) {
    generation += 1
    inFlight = null
    commitSession(null)
    initialized = Boolean(resolved)
    lastValidatedAt = resolved ? now() : 0
  }

  function shouldRevalidate() {
    return initialized && now() - lastValidatedAt >= intervalMs
  }

  return {
    initialize,
    revalidate,
    accept,
    invalidate,
    shouldRevalidate,
    isInitialized: () => initialized,
    isResolving: () => Boolean(inFlight),
    getLastValidatedAt: () => lastValidatedAt
  }
}
