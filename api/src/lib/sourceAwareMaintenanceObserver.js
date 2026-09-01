function normalizedSourceKey(value) {
  const sourceKey = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9_.-]{1,80}$/.test(sourceKey)) {
    throw new TypeError('Maintenance observer source key is invalid')
  }
  return sourceKey
}

// Several mailbox runtimes intentionally share one persisted maintenance job.
// A successful run from one source must not clear another source's active
// failure. The last failing source to recover publishes the shared recovery.
export function createSourceAwareMaintenanceObserverGroup(observer, { sourceKeys = [] } = {}) {
  const states = new Map(sourceKeys.map((value) => [normalizedSourceKey(value), 'unknown']))
  return {
    forSource(value) {
      const sourceKey = normalizedSourceKey(value)
      if (!states.has(sourceKey)) states.set(sourceKey, 'unknown')
      return {
        async failed(payload) {
          states.set(sourceKey, 'failed')
          return observer?.failed?.(payload)
        },
        async succeeded(payload) {
          if (payload?.result?.skipped) return undefined
          states.set(sourceKey, 'healthy')
          if ([...states.values()].some((state) => state !== 'healthy')) return undefined
          return observer?.succeeded?.(payload)
        },
        async deferred(payload) {
          return observer?.deferred?.(payload)
        }
      }
    },
    failingSources() {
      return [...states.entries()]
        .filter(([, state]) => state === 'failed')
        .map(([sourceKey]) => sourceKey)
        .sort()
    }
  }
}
