export function createRegistrationGeneration() {
  let currentGeneration = 0

  return Object.freeze({
    current() {
      return currentGeneration
    },
    isCurrent(candidate) {
      return candidate === currentGeneration
    },
    invalidate() {
      currentGeneration += 1
      return currentGeneration
    }
  })
}

export function isRootServiceWorkerScope(scope, origin) {
  try {
    return new URL(scope).href === new URL('/', origin).href
  } catch {
    return false
  }
}
