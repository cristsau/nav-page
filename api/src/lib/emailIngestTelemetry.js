function boundedSampleSize(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 8 && parsed <= 512 ? parsed : 64
}

function normalizedLatency(value) {
  const parsed = Math.round(Number(value) || 0)
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, parsed))
}

function increment(value) {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1
}

export function latencyPercentile(samples, percentile) {
  const values = (Array.isArray(samples) ? samples : [])
    .map(normalizedLatency)
    .sort((left, right) => left - right)
  if (!values.length) return 0
  const fraction = Math.max(0, Math.min(1, Number(percentile) || 0))
  const index = Math.max(0, Math.ceil(values.length * fraction) - 1)
  return values[index]
}

export function createEmailIngestTelemetry({ sampleSize = 64 } = {}) {
  const limit = boundedSampleSize(sampleSize)
  const connectionLatencies = []
  const syncLatencies = []
  let connectionAttempts = 0
  let connectionRetries = 0
  let connectionFailures = 0
  let reconnects = 0
  const disconnectedConnections = new Set()

  const append = (target, value) => {
    target.push(normalizedLatency(value))
    if (target.length > limit) target.splice(0, target.length - limit)
  }

  return {
    recordConnectionAttempt({ durationMs, succeeded, retry = false, connection = 'primary' } = {}) {
      const connectionKey = String(connection || 'primary').slice(0, 32)
      connectionAttempts = increment(connectionAttempts)
      if (retry) connectionRetries = increment(connectionRetries)
      if (!succeeded) connectionFailures = increment(connectionFailures)
      if (succeeded && (retry || disconnectedConnections.has(connectionKey))) reconnects = increment(reconnects)
      if (succeeded) disconnectedConnections.delete(connectionKey)
      append(connectionLatencies, durationMs)
    },
    recordDisconnect(connection = 'primary') {
      disconnectedConnections.add(String(connection || 'primary').slice(0, 32))
    },
    recordSync(durationMs) {
      append(syncLatencies, durationMs)
    },
    snapshot() {
      return {
        connectionAttempts,
        connectionRetries,
        connectionFailures,
        reconnects,
        connectLatencyP50Ms: latencyPercentile(connectionLatencies, 0.50),
        connectLatencyP95Ms: latencyPercentile(connectionLatencies, 0.95),
        syncLatencyP50Ms: latencyPercentile(syncLatencies, 0.50),
        syncLatencyP95Ms: latencyPercentile(syncLatencies, 0.95),
        telemetrySamples: Math.max(connectionLatencies.length, syncLatencies.length)
      }
    }
  }
}
