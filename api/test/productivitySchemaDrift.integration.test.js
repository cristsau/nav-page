import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const enabled = process.env.NAV_PRODUCTIVITY_SCHEMA_DRIFT_TEST === 'true'
const apiRoot = fileURLToPath(new URL('..', import.meta.url))

const constraintCases = [
  {
    table: 'notes',
    name: 'notes_remind_before_minutes_check',
    restore: 'CHECK (remind_before_minutes BETWEEN 0 AND 43200)'
  },
  {
    table: 'notes',
    name: 'notes_revision_check',
    restore: 'CHECK (revision >= 1)'
  },
  {
    table: 'note_reminders',
    name: 'note_reminders_advance_minutes_check',
    restore: 'CHECK (remind_before_minutes_snapshot BETWEEN 0 AND 43200)'
  },
  {
    table: 'note_versions',
    name: 'note_versions_revision_check',
    restore: 'CHECK (revision >= 1)'
  },
  {
    table: 'note_versions',
    name: 'note_versions_remind_before_check',
    restore: 'CHECK (remind_before_minutes BETWEEN 0 AND 43200)'
  },
  {
    table: 'note_versions',
    name: 'note_versions_note_revision_unique',
    restore: 'UNIQUE (note_id, revision)'
  },
  {
    table: 'note_versions',
    name: 'note_versions_user_id_fkey',
    restore: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'
  },
  {
    table: 'note_versions',
    name: 'note_versions_note_id_fkey',
    restore: 'FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE'
  }
]

function runVerifier() {
  return spawnSync(process.execPath, ['src/db/verifyMigrations.js'], {
    cwd: apiRoot,
    env: process.env,
    encoding: 'utf8'
  })
}

function expectVerificationFailure(label) {
  const verification = runVerifier()
  assert.notEqual(
    verification.status,
    0,
    `${label} drift unexpectedly passed verification`
  )
  assert.match(
    `${verification.stdout}\n${verification.stderr}`,
    /productivity constraints|definition mismatch|foreign key mismatch|columns mismatch/
  )
}

test('productivity migration verification fails closed for every integrity constraint', {
  skip: !enabled
}, async () => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    for (const constraint of constraintCases) {
      await pool.query(
        `ALTER TABLE ${constraint.table} DROP CONSTRAINT ${constraint.name}`
      )

      try {
        expectVerificationFailure(constraint.name)
      } finally {
        await pool.query(
          `ALTER TABLE ${constraint.table} ADD CONSTRAINT ${constraint.name} ${constraint.restore}`
        )
      }
    }

    await pool.query('ALTER TABLE notes DROP CONSTRAINT notes_revision_check')
    await pool.query(`
      ALTER TABLE notes
      ADD CONSTRAINT notes_revision_check
      CHECK (revision >= 1 OR revision < 1)
    `)
    try {
      expectVerificationFailure('weakened notes revision check')
    } finally {
      await pool.query('ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_revision_check')
      await pool.query(`
        ALTER TABLE notes
        ADD CONSTRAINT notes_revision_check CHECK (revision >= 1)
      `)
    }

    await pool.query('ALTER TABLE note_versions DROP CONSTRAINT note_versions_user_id_fkey')
    await pool.query(`
      ALTER TABLE note_versions
      ADD CONSTRAINT note_versions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID
    `)
    try {
      expectVerificationFailure('not-valid user cascade')
    } finally {
      await pool.query('ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_user_id_fkey')
      await pool.query(`
        ALTER TABLE note_versions
        ADD CONSTRAINT note_versions_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      `)
    }

    await pool.query('ALTER TABLE note_versions DROP CONSTRAINT note_versions_note_id_fkey')
    await pool.query(`
      ALTER TABLE note_reminders
      ADD CONSTRAINT note_versions_note_id_fkey
      FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
    `)
    try {
      expectVerificationFailure('misplaced note cascade')
    } finally {
      await pool.query('ALTER TABLE note_reminders DROP CONSTRAINT IF EXISTS note_versions_note_id_fkey')
      await pool.query(`
        ALTER TABLE note_versions
        ADD CONSTRAINT note_versions_note_id_fkey
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      `)
    }

    await pool.query('ALTER TABLE note_versions DROP CONSTRAINT note_versions_note_revision_unique')
    await pool.query(`
      ALTER TABLE note_versions
      ADD CONSTRAINT note_versions_note_revision_unique UNIQUE (user_id, note_id)
    `)
    try {
      expectVerificationFailure('wrong version uniqueness columns')
    } finally {
      await pool.query(
        'ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_note_revision_unique'
      )
      await pool.query(`
        ALTER TABLE note_versions
        ADD CONSTRAINT note_versions_note_revision_unique UNIQUE (note_id, revision)
      `)
    }

    const finalVerification = runVerifier()
    assert.equal(
      finalVerification.status,
      0,
      `${finalVerification.stdout}\n${finalVerification.stderr}`
    )
  } finally {
    await pool.end()
  }
})
