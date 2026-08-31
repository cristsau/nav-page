import path from 'node:path'
import process from 'node:process'
import { normalizePublicAppOrigin } from './lib/publicSharePage.js'
import { WEBAUTHN_RELYING_PARTIES } from './lib/webauthnRelyingParties.js'

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeBoundedPositiveInteger(
  value,
  fallback,
  { minimum = 1, maximum }
) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback
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

function normalizeEmailRuntimeRole(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return new Set(['combined', 'api', 'worker']).has(normalized)
    ? normalized
    : 'combined'
}

const nodeEnv = process.env.NODE_ENV || 'development'
const emailRuntimeRole = normalizeEmailRuntimeRole(process.env.NAV_EMAIL_RUNTIME_ROLE)

// The dedicated mail worker permanently reserves one pooled connection for
// the IMAP advisory lease plus one LISTEN connection for each ingest and
// classification wake channel. Keep two additional slots available so normal
// work and maintenance observation cannot be starved by those three long-lived
// connections.
export const MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE = 5

export function normalizeDatabasePoolMax(value, role = emailRuntimeRole) {
  const normalizedRole = normalizeEmailRuntimeRole(role)
  const fallback = normalizedRole === 'worker' ? 8 : 6
  const normalized = normalizeBoundedPositiveInteger(value, fallback, {
    minimum: 1,
    maximum: 32
  })
  // Preserve an explicit, syntactically valid low worker value so the worker
  // can fail closed with an actionable error instead of silently ignoring an
  // operator's unsafe override. Missing or malformed values use the safe
  // role-specific default.
  return normalized
}

export function assertSafeMailWorkerDatabasePoolSize(value) {
  if (value < MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE) {
    const error = new Error('nav-mail-worker database pool is below the safe runtime minimum')
    error.code = 'MAIL_WORKER_DATABASE_POOL_TOO_SMALL'
    throw error
  }
  return value
}

function normalizeTrustedProxyAddresses(value) {
  return String(value || '')
    .split(',')
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
}

function normalizeCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeHourList(value, fallback = [12, 20]) {
  const hours = normalizeCsv(value)
    .map(Number)
    .filter((hour) => Number.isSafeInteger(hour) && hour >= 0 && hour <= 23)
  return [...new Set(hours.length ? hours : fallback)].sort((left, right) => left - right)
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
  databasePoolMax: normalizeDatabasePoolMax(
    process.env.NAV_DATABASE_POOL_MAX,
    emailRuntimeRole
  ),
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
  authPasskeyRateLimitMax: normalizePositiveInteger(
    process.env.AUTH_PASSKEY_RATE_LIMIT_MAX,
    30
  ),
  authPasskeyRateLimitWindowSeconds: normalizePositiveInteger(
    process.env.AUTH_PASSKEY_RATE_LIMIT_WINDOW_SECONDS,
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
  noteReminderSchedulerEnabled:
    process.env.NAV_NOTE_REMINDER_SCHEDULER_ENABLED === 'true',
  noteReminderSchedulerIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_NOTE_REMINDER_SCHEDULER_INTERVAL_SECONDS,
    60
  ),
  noteReminderSchedulerBatchSize: normalizePositiveInteger(
    process.env.NAV_NOTE_REMINDER_SCHEDULER_BATCH_SIZE,
    500
  ),
  bookmarkHealthSchedulerEnabled:
    process.env.NAV_BOOKMARK_HEALTH_SCHEDULER_ENABLED === 'true',
  bookmarkHealthSchedulerIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_BOOKMARK_HEALTH_SCHEDULER_INTERVAL_SECONDS,
    3_600
  ),
  bookmarkHealthSchedulerBatchSize: normalizePositiveInteger(
    process.env.NAV_BOOKMARK_HEALTH_SCHEDULER_BATCH_SIZE,
    20
  ),
  bookmarkHealthSchedulerStaleHours: normalizePositiveInteger(
    process.env.NAV_BOOKMARK_HEALTH_SCHEDULER_STALE_HOURS,
    168
  ),
  bookmarkHealthSchedulerConcurrency: normalizePositiveInteger(
    process.env.NAV_BOOKMARK_HEALTH_SCHEDULER_CONCURRENCY,
    2
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
  mailWorkerPoolWaitAlertSeconds: normalizeBoundedPositiveInteger(
    process.env.NAV_MAIL_WORKER_POOL_WAIT_ALERT_SECONDS,
    60,
    { minimum: 30, maximum: 600 }
  ),
  aiUsageRetentionEnabled:
    process.env.NAV_AI_USAGE_RETENTION_ENABLED === 'true',
  aiUsageRetentionDays: normalizePositiveInteger(
    process.env.NAV_AI_USAGE_RETENTION_DAYS,
    400
  ),
  aiUsageRetentionIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_AI_USAGE_RETENTION_INTERVAL_SECONDS,
    86_400
  ),
  aiUsageRetentionBatchSize: normalizePositiveInteger(
    process.env.NAV_AI_USAGE_RETENTION_BATCH_SIZE,
    500
  ),
  aiUsageRetentionMaxBatchesPerRun: normalizePositiveInteger(
    process.env.NAV_AI_USAGE_RETENTION_MAX_BATCHES_PER_RUN,
    4
  ),
  hybridSearchEnabled: process.env.NAV_HYBRID_SEARCH_ENABLED !== 'false',
  semanticSearchEnabled: process.env.NAV_SEMANTIC_SEARCH_ENABLED === 'true',
  embeddingModel: String(
    process.env.NAV_EMBEDDING_MODEL
      || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
  ).trim(),
  embeddingModelRevision: String(
    process.env.NAV_EMBEDDING_MODEL_REVISION
      || '2c4055b12046f11709e9df2c122e59ffbdc2f900'
  ).trim(),
  embeddingCacheDir: path.resolve(
    String(process.env.NAV_EMBEDDING_CACHE_DIR || '/var/cache/nav-models').trim()
  ),
  embeddingSchedulerEnabled:
    process.env.NAV_EMBEDDING_SCHEDULER_ENABLED === 'true',
  embeddingSchedulerIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_EMBEDDING_SCHEDULER_INTERVAL_SECONDS,
    300
  ),
  embeddingSchedulerBatchSize: normalizePositiveInteger(
    process.env.NAV_EMBEDDING_SCHEDULER_BATCH_SIZE,
    24
  ),
  webPushEnabled: process.env.NAV_WEB_PUSH_ENABLED === 'true',
  webPushVapidSubject: String(
    process.env.NAV_WEB_PUSH_VAPID_SUBJECT || 'https://nav.skrskr.net'
  ).trim(),
  webPushVapidPublicKey: String(
    process.env.NAV_WEB_PUSH_VAPID_PUBLIC_KEY || ''
  ).trim(),
  webPushVapidPrivateKeyFile: String(
    process.env.NAV_WEB_PUSH_VAPID_PRIVATE_KEY_FILE || ''
  ).trim(),
  webPushAllowedEndpointHosts: String(
    process.env.NAV_WEB_PUSH_ALLOWED_ENDPOINT_HOSTS
      || 'fcm.googleapis.com,push.services.mozilla.com,updates.push.services.mozilla.com,web.push.apple.com,notify.windows.com'
  ).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
  webPushSchedulerEnabled:
    process.env.NAV_WEB_PUSH_SCHEDULER_ENABLED === 'true',
  webPushSchedulerIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_WEB_PUSH_SCHEDULER_INTERVAL_SECONDS,
    60
  ),
  webPushSchedulerBatchSize: normalizePositiveInteger(
    process.env.NAV_WEB_PUSH_SCHEDULER_BATCH_SIZE,
    100
  ),
  webPushMaxAttempts: normalizePositiveInteger(
    process.env.NAV_WEB_PUSH_MAX_ATTEMPTS,
    6
  ),
  mailDeliveryEnabled: process.env.NAV_MAIL_DELIVERY_ENABLED === 'true',
  emailRuntimeRole,
  mailDeliveryIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_MAIL_DELIVERY_INTERVAL_SECONDS,
    30
  ),
  mailDeliveryBatchSize: normalizePositiveInteger(
    process.env.NAV_MAIL_DELIVERY_BATCH_SIZE,
    25
  ),
  mailDeliveryMaxAttempts: normalizePositiveInteger(
    process.env.NAV_MAIL_DELIVERY_MAX_ATTEMPTS,
    8
  ),
  smtpHost: String(process.env.NAV_SMTP_HOST || '').trim(),
  smtpPort: normalizePositiveInteger(process.env.NAV_SMTP_PORT, 465),
  smtpSecure: process.env.NAV_SMTP_SECURE !== 'false',
  smtpUsername: String(process.env.NAV_SMTP_USERNAME || '').trim(),
  smtpPasswordFile: String(process.env.NAV_SMTP_PASSWORD_FILE || '').trim(),
  smtpOauthProvider: '',
  smtpFromAddress: String(process.env.NAV_SMTP_FROM_ADDRESS || '').trim(),
  smtpFromName: String(process.env.NAV_SMTP_FROM_NAME || 'DOMO NAV').trim(),
  adminEmailRecipients: normalizeCsv(process.env.NAV_ADMIN_EMAIL_RECIPIENTS),
  registrationEmailEnabled: process.env.NAV_REGISTRATION_EMAIL_ENABLED === 'true',
  registrationEmailVerificationMinutes: normalizePositiveInteger(
    process.env.NAV_REGISTRATION_EMAIL_VERIFICATION_MINUTES,
    30
  ),
  emailIngestEnabled: process.env.NAV_EMAIL_INGEST_ENABLED === 'true',
  emailSourceKey: String(process.env.NAV_EMAIL_SOURCE_KEY || 'mxroute').trim().toLowerCase(),
  emailOwnerUsername: String(process.env.NAV_EMAIL_OWNER_USERNAME || '').trim(),
  emailEncryptionKeyFile: String(process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE || '').trim(),
  imapHost: String(process.env.NAV_IMAP_HOST || '').trim(),
  imapPort: normalizePositiveInteger(process.env.NAV_IMAP_PORT, 993),
  imapSecure: process.env.NAV_IMAP_SECURE !== 'false',
  imapUsername: String(process.env.NAV_IMAP_USERNAME || '').trim(),
  imapPasswordFile: String(process.env.NAV_IMAP_PASSWORD_FILE || '').trim(),
  imapOauthProvider: '',
  imapMailbox: String(process.env.NAV_IMAP_MAILBOX || 'INBOX').trim(),
  emailSentAppendEnabled: process.env.NAV_EMAIL_SENT_APPEND_ENABLED === 'true',
  imapSentMailbox: String(process.env.NAV_IMAP_SENT_MAILBOX || '').trim(),
  emailSentAppendIntervalSeconds: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_SENT_APPEND_INTERVAL_SECONDS,
    30,
    { minimum: 15, maximum: 3600 }
  ),
  emailSentAppendBatchSize: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_SENT_APPEND_BATCH_SIZE,
    5,
    { maximum: 25 }
  ),
  emailSentAppendRetentionDays: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_SENT_APPEND_RETENTION_DAYS,
    30,
    { maximum: 365 }
  ),
  imapPollIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_IMAP_POLL_INTERVAL_SECONDS,
    60
  ),
  imapInitialLookback: normalizePositiveInteger(
    process.env.NAV_IMAP_INITIAL_LOOKBACK,
    1000
  ),
  imapBatchSize: normalizePositiveInteger(
    process.env.NAV_IMAP_BATCH_SIZE,
    100
  ),
  imapMaxMessageBytes: normalizePositiveInteger(
    process.env.NAV_IMAP_MAX_MESSAGE_BYTES,
    512 * 1024
  ),
  imapDrainMaxBatches: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_DRAIN_MAX_BATCHES,
    10,
    { maximum: 50 }
  ),
  imapDrainMaxMilliseconds: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_DRAIN_MAX_MILLISECONDS,
    15_000,
    { minimum: 1_000, maximum: 60_000 }
  ),
  imapFolderSyncIntervalSeconds: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_FOLDER_SYNC_INTERVAL_SECONDS,
    900,
    { minimum: 60, maximum: 86_400 }
  ),
  imapFoldersPerRun: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_FOLDERS_PER_RUN,
    2,
    { maximum: 20 }
  ),
  imapReconcileMaxMessages: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_RECONCILE_MAX_MESSAGES,
    20_000,
    { minimum: 100, maximum: 100_000 }
  ),
  imapReconcileBatchSize: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_RECONCILE_BATCH_SIZE,
    500,
    { minimum: 10, maximum: 2_000 }
  ),
  imapTelemetrySampleSize: normalizeBoundedPositiveInteger(
    process.env.NAV_IMAP_TELEMETRY_SAMPLE_SIZE,
    64,
    { minimum: 8, maximum: 512 }
  ),
  emailClassificationIntervalSeconds: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CLASSIFICATION_INTERVAL_SECONDS,
    2,
    { maximum: 300 }
  ),
  emailClassificationBatchSize: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CLASSIFICATION_BATCH_SIZE,
    10,
    { maximum: 50 }
  ),
  emailClassificationMaxAttempts: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CLASSIFICATION_MAX_ATTEMPTS,
    5,
    { maximum: 10 }
  ),
  emailCacheRetentionEnabled:
    process.env.NAV_EMAIL_CACHE_RETENTION_ENABLED !== 'false',
  emailCacheRetentionDays: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CACHE_RETENTION_DAYS,
    180,
    { maximum: 3_650 }
  ),
  emailCacheMaxMessagesPerAccount: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CACHE_MAX_MESSAGES_PER_ACCOUNT,
    5_000,
    { maximum: 100_000 }
  ),
  emailCacheRetentionBatchSize: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CACHE_RETENTION_BATCH_SIZE,
    200,
    { maximum: 200 }
  ),
  emailCacheRetentionMaxDeletesPerRun: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CACHE_RETENTION_MAX_DELETES_PER_RUN,
    200,
    { maximum: 200 }
  ),
  emailCacheRetentionIntervalSeconds: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_CACHE_RETENTION_INTERVAL_SECONDS,
    21_600,
    { minimum: 300, maximum: 7 * 24 * 60 * 60 }
  ),
  emailOutboxRetentionDays: normalizeBoundedPositiveInteger(
    process.env.NAV_EMAIL_OUTBOX_RETENTION_DAYS,
    30,
    { maximum: 3_650 }
  ),
  emailDigestEnabled: process.env.NAV_EMAIL_DIGEST_ENABLED === 'true',
  emailDigestIntervalSeconds: normalizePositiveInteger(
    process.env.NAV_EMAIL_DIGEST_INTERVAL_SECONDS,
    60
  ),
  emailDigestHours: normalizeHourList(process.env.NAV_EMAIL_DIGEST_HOURS),
  emailDigestTimeZone: String(
    process.env.NAV_EMAIL_DIGEST_TIME_ZONE || 'Asia/Shanghai'
  ).trim(),
  managedIntegrationsDir: String(
    process.env.NAV_MANAGED_INTEGRATIONS_DIR || ''
  ).trim(),
  allowPrivateIntegrationEndpoints: process.env.NAV_ALLOW_PRIVATE_INTEGRATION_ENDPOINTS === 'true',
  aiPriceCatalogJson: String(
    process.env.NAV_AI_PRICE_CATALOG_JSON || ''
  ).trim(),
  trustedProxyAddresses: normalizeTrustedProxyAddresses(
    process.env.TRUSTED_PROXY_ADDRESSES
  ),
  webauthnEnabled: process.env.NAV_WEBAUTHN_ENABLED === 'true',
  webauthnRpId: 'nav.skrskr.net',
  webauthnOrigin: 'https://nav.skrskr.net',
  webauthnRelyingParties: WEBAUTHN_RELYING_PARTIES,
  webauthnRpName: 'DOMO NAV',
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
