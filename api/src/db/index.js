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

export const MIGRATION_ADVISORY_LOCK_SQL = `
  SELECT pg_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_schema_migrations')
  )
`

export const MIGRATION_ADVISORY_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_schema_migrations')
  )
`

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

export async function ensureMigrationTable(queryFn = query) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

async function runMigrationTransaction(client, file, sql) {
  await client.query('BEGIN')

  try {
    await client.query(sql)
    await client.query(
      'INSERT INTO schema_migrations (name) VALUES ($1)',
      [file]
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function runMigrations({
  poolInstance = pool,
  fileSystem = fs,
  migrationsDir = config.migrationsDir
} = {}) {
  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null

  try {
    await client.query(MIGRATION_ADVISORY_LOCK_SQL)
    lockAcquired = true

    const clientQuery = client.query.bind(client)
    await ensureMigrationTable(clientQuery)

    const entries = await fileSystem.readdir(migrationsDir, {
      withFileTypes: true
    })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort()

    for (const file of files) {
      const existing = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [file]
      )
      if (existing.rowCount > 0) continue

      const sql = await fileSystem.readFile(
        path.join(migrationsDir, file),
        'utf8'
      )
      await runMigrationTransaction(client, file, sql)
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(MIGRATION_ADVISORY_UNLOCK_SQL)
      } catch (error) {
        unlockError = error
      }
    }

    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}
