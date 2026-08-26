export function createRecoverableSerialQueue() {
  let tail = Promise.resolve()
  return {
    run(operation) {
      if (typeof operation !== 'function') throw new TypeError('Runtime operation is required')
      const result = tail.then(operation, operation)
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    wait() {
      return tail
    }
  }
}

export async function stopRuntimeFunctions(functions = []) {
  const stops = [...functions].reverse()
  const results = await Promise.allSettled(
    stops.map((stop) => Promise.resolve().then(() => stop()))
  )
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (failures.length) throw new AggregateError(failures, 'One or more runtime stop functions failed')
}

export async function startRuntimeFunctions(starters = []) {
  const started = []
  try {
    for (const start of starters) {
      const stop = await Promise.resolve().then(() => start())
      if (typeof stop !== 'function') throw new TypeError('Runtime starter must return a stop function')
      started.push(stop)
    }
    return started
  } catch (error) {
    try {
      await stopRuntimeFunctions(started)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime startup and cleanup both failed')
    }
    throw error
  }
}
