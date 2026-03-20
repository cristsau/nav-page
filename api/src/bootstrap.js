import { config } from './config.js'
import { query } from './db/index.js'
import { hashPassword, normalizeUsername } from './lib/auth.js'

export async function ensureAdminUser() {
  const existingAdmin = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
  if (existingAdmin.rowCount > 0) return

  const username = normalizeUsername(config.adminUsername)
  const password = String(config.adminPassword || '')

  if (!username || !password) {
    throw new Error('No admin user exists. Please provide ADMIN_USERNAME and ADMIN_PASSWORD in api/.env before starting the server.')
  }

  await query(
    `
      INSERT INTO users (
        username,
        password_hash,
        role,
        status,
        approved_at
      ) VALUES ($1, $2, 'admin', 'approved', NOW())
    `,
    [username, await hashPassword(password)]
  )
}
