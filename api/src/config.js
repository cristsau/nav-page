import path from 'node:path'
import process from 'node:process'
import { normalizePublicAppOrigin } from './lib/publicSharePage.js'

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const nodeEnv = process.env.NODE_ENV || 'development'

export const config = {
  nodeEnv,
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgres://nav:nav_password@127.0.0.1:5432/nav',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'nav_session',
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 14),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5174',
  allowPrivateAiEndpoints: process.env.ALLOW_PRIVATE_AI_ENDPOINTS === 'true',
  allowInsecureAiEndpoints: process.env.ALLOW_INSECURE_AI_ENDPOINTS === 'true',
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  imgBedBaseUrl: String(process.env.NAV_IMGBED_BASE_URL || '').trim(),
  imgBedUploadToken: String(process.env.NAV_IMGBED_UPLOAD_TOKEN || '').trim(),
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
