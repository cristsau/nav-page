import fs from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { config } from '../config.js'

export const pool = new Pool({
  connectionString: config.databaseUrl
})

export async function query(text, params = []) {
  return pool.query(text, params)
}

export async function withTransaction(callback) {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function ensureMigrationTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

export async function runMigrations() {
  await ensureMigrationTable()

  const entries = await fs.readdir(config.migrationsDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort()

  for (const file of files) {
    const existing = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
    if (existing.rowCount > 0) continue

    const sql = await fs.readFile(path.join(config.migrationsDir, file), 'utf8')

    await withTransaction(async (client) => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
  }
}
