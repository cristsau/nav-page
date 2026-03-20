import path from 'node:path'
import process from 'node:process'

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL || 'postgres://nav:nav_password@127.0.0.1:5432/nav',
  sessionCookieName: process.env.SESSION_COOKIE_NAME || 'nav_session',
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 14),
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5174',
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  migrationsDir: path.resolve(process.cwd(), 'src', 'db', 'migrations')
}

export function isProduction() {
  return config.nodeEnv === 'production'
}
