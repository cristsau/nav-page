import { config } from '../config.js'

// Absolute lifetimes, never extended by polling, page visibility or last_seen_at.
export function sessionLifetimeDays(trustDevice = false, runtime = config) {
  const configured = Number(runtime.sessionTtlDays)
  const standard = Number.isFinite(configured) ? Math.min(14, Math.max(1, configured)) : 14
  return trustDevice === true ? 30 : standard
}

export function sessionCookieMaxAge(trustDevice = false, runtime = config) {
  return sessionLifetimeDays(trustDevice, runtime) * 86400
}
