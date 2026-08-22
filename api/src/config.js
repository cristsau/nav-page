import path from 'node:path'
import process from 'node:process'
import { normalizePublicAppOrigin } from './lib/publicSharePage.js'

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeLogLevel(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase()
  return new Set([
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent'
  ]).has(normalized)
    ? normalized
    : fallback
}

const nodeEnv = process.env.NODE_ENV || 'development'

function normalizeTrustedProxyAddresses(value) {
  return String(value || '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
}

export const config = {
  nodeEnv,
  apiLogLevel: normalizeLogLevel(
    process.env.NAV_LOG_LEVEL,
    nodeEnv === 'production' ? 'warn' : 'info'
  ),
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgres://nav:nav_password@127.0.0.1:5432/nav',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'nav_session',
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 14),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  sessionTouchIntervalSeconds: normalizePositiveInteger(
    process.env.SESSION_TOUCH_INTERVAL_SECONDS,
    300
  ),
  sessionCleanupIntervalSeconds: normalizePositiveInteger(
    process.env.SESSION_CLEANUP_INTERVAL_SECONDS,
    900
  ),
  authLoginRateLimitMax: normalizePositiveInteger(
    process.env.AUTH_LOGIN_RATE_LIMIT_MAX,
    10
  ),
  authLoginRateLimitWindowSeconds: normalizePositiveInteger(
    process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    900
  ),
  authRegisterRateLimitMax: normalizePositiveInteger(
    process.env.AUTH_REGISTER_RATE_LIMIT_MAX,
    5
  ),
  authRegisterRateLimitWindowSeconds: normalizePositiveInteger(
    process.env.AUTH_REGISTER_RATE_LIMIT_WINDOW_SECONDS,
    3600
  ),
  authRecoveryRateLimitMax: normalizePositiveInteger(
    process.env.AUTH_RECOVERY_RATE_LIMIT_MAX,
    5
  ),
  authRecoveryRateLimitWindowSeconds: normalizePositiveInteger(
    process.env.AUTH_RECOVERY_RATE_LIMIT_WINDOW_SECONDS,
    1800
  ),
  authenticatedWriteRateLimitMax: normalizePositiveInteger(
    process.env.AUTHENTICATED_WRITE_RATE_LIMIT_MAX,
    120
  ),
  authenticatedWriteRateLimitWindowSeconds: normalizePositiveInteger(
    process.env.AUTHENTICATED_WRITE_RATE_LIMIT_WINDOW_SECONDS,
    60
  ),
  rateLimitKeySecret: String(
    process.env.NAV_RATE_LIMIT_KEY_SECRET || ''
  ).trim(),
  securityEventRetentionEnabled:
    process.env.NAV_SECURITY_EVENT_RETENTION_ENABLED === 'true',
  securityEventRoutineRetentionDays: normalizePositiveInteger(
    process.env.NAV_SECURITY_EVENT_ROUTINE_RETENTION_DAYS,
    90
  ),
  securityEventDeniedRetentionDays: normalizePositiveInteger(
    process.env.NAV_SECURITY_EVENT_DENIED_RETENTION_DAYS,
    180
  ),
  securityEventCriticalRetentionDays: normalizePositiveInteger(
    process.env.NAV_SECURITY_EVENT_CRITICAL_RETENTION_DAYS,
    365
  ),
  securityEventRetentionIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_SECURITY_EVENT_RETENTION_INTERVAL_SECONDS,
    21_600
  ),
  securityEventRetentionBatchSize: normalizePositiveInteger(
    process.env.NAV_SECURITY_EVENT_RETENTION_BATCH_SIZE,
    500
  ),
  securityEventRetentionMaxBatchesPerRun: normalizePositiveInteger(
    process.env.NAV_SECURITY_EVENT_RETENTION_MAX_BATCHES_PER_RUN,
    20
  ),
  mediaDeleteRetryEnabled:
    process.env.NAV_MEDIA_DELETE_RETRY_ENABLED === 'true',
  mediaDeleteRetryIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_MEDIA_DELETE_RETRY_INTERVAL_SECONDS,
    3_600
  ),
  mediaDeleteRetryBatchSize: normalizePositiveInteger(
    process.env.NAV_MEDIA_DELETE_RETRY_BATCH_SIZE,
    10
  ),
  mediaDeleteRetryMaxAttempts: normalizePositiveInteger(
    process.env.NAV_MEDIA_DELETE_RETRY_MAX_ATTEMPTS,
    8
  ),
  mediaDeleteRetryBaseBackoffSeconds: normalizePositiveInteger(
    process.env.NAV_MEDIA_DELETE_RETRY_BASE_BACKOFF_SECONDS,
    900
  ),
  mediaDeleteRetryMaxBackoffSeconds: normalizePositiveInteger(
    process.env.NAV_MEDIA_DELETE_RETRY_MAX_BACKOFF_SECONDS,
    86_400
  ),
  maintenanceAlertsEnabled:
    process.env.NAV_MAINTENANCE_ALERTS_ENABLED === 'true',
  maintenanceAlertFailureThreshold: normalizePositiveInteger(
    process.env.NAV_MAINTENANCE_ALERT_FAILURE_THRESHOLD,
    3
  ),
  maintenanceAlertCooldownSeconds: normalizePositiveInteger(
    process.env.NAV_MAINTENANCE_ALERT_COOLDOWN_SECONDS,
    21_600
  ),
  trustedProxyAddresses: normalizeTrustedProxyAddresses(
    process.env.TRUSTED_PROXY_ADDRESSES
  ),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5174',
  allowPrivateAiEndpoints: process.env.ALLOW_PRIVATE_AI_ENDPOINTS === 'true',
  allowInsecureAiEndpoints: process.env.ALLOW_INSECURE_AI_ENDPOINTS === 'true',
  aiCliProxyBaseUrl: String(process.env.NAV_AI_CLI_PROXY_BASE_URL || '').trim(),
  aiCliProxyApiMode: String(
    process.env.NAV_AI_CLI_PROXY_API_MODE || 'chat-completions'
  ).trim(),
  aiCliProxyApiKeyFile: String(process.env.NAV_AI_CLI_PROXY_API_KEY_FILE || '').trim(),
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  imgBedBaseUrl: String(process.env.NAV_IMGBED_BASE_URL || '').trim(),
  imgBedUploadToken: String(process.env.NAV_IMGBED_UPLOAD_TOKEN || '').trim(),
  imgBedLibraryTokenFile: String(
    process.env.NAV_IMGBED_LIBRARY_TOKEN_FILE || ''
  ).trim(),
  imgBedUploadFolder: String(process.env.NAV_IMGBED_UPLOAD_FOLDER || 'nav-notes').trim(),
  imgBedMaxImageBytes: normalizePositiveInteger(
    process.env.NAV_IMGBED_MAX_IMAGE_BYTES,
    10 * 1024 * 1024
  ),
  publicAppOrigin: normalizePublicAppOrigin(
    process.env.NAV_PUBLIC_APP_ORIGIN,
    { production: nodeEnv === 'production' }
  ),
  frontendIndexPath: path.resolve(
    String(
      process.env.NAV_FRONTEND_INDEX_PATH
      || (nodeEnv === 'production'
        ? '/var/www/nav/index.html'
        : path.resolve(process.cwd(), '..', 'app', 'dist', 'index.html'))
    ).trim()
  ),
  migrationsDir: path.resolve(process.cwd(), 'src', 'db', 'migrations')
}

export function isProduction() {
  return config.nodeEnv === 'production'
}
