import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const enabled = process.env.NAV_COLLABORATION_REALTIME_SCHEMA_DRIFT_TEST === 'true'
const apiRoot = fileURLToPath(new URL('..', import.meta.url))
const migrationPath = fileURLToPath(
  new URL('../src/db/migrations/028_realtime_collaboration_events.sql', import.meta.url)
)

function runVerifier() {
  return spawnSync(process.execPath, ['src/db/verifyMigrations.js'], {
    cwd: apiRoot,
    env: process.env,
    encoding: 'utf8'
  })
}

function expectVerificationFailure(label) {
  const verification = runVerifier()
  assert.notEqual(verification.status, 0, `${label} drift unexpectedly passed verification`)
  assert.match(
    `${verification.stdout}\n${verification.stderr}`,
    /collaboration\/offline triggers must be enabled|notification function definition mismatch/
  )
}

test('realtime collaboration migration verification fails closed for trigger drift', {
  skip: !enabled
}, async () => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const migrationSql = await readFile(migrationPath, 'utf8')

  try {
    await pool.query('ALTER TABLE note_sync_events DISABLE TRIGGER trg_note_sync_events_notify')
    try {
      expectVerificationFailure('disabled realtime notification trigger')
    } finally {
      await pool.query('ALTER TABLE note_sync_events ENABLE TRIGGER trg_note_sync_events_notify')
    }

    await pool.query(`
      CREATE OR REPLACE FUNCTION nav_notify_note_sync_event()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$
    `)
    try {
      expectVerificationFailure('weakened realtime notification function')
    } finally {
      await pool.query(migrationSql)
    }

    const finalVerification = runVerifier()
    assert.equal(finalVerification.status, 0, `${finalVerification.stdout}\n${finalVerification.stderr}`)
  } finally {
    await pool.end()
  }
})
