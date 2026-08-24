import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const enabled = process.env.NAV_ADVANCED_FEATURES_SCHEMA_DRIFT_TEST === 'true'
const apiRoot = fileURLToPath(new URL('..', import.meta.url))

const constraintCases = [
  {
    table: 'workspace_search_index_state',
    name: 'workspace_search_index_state_user_id_fkey',
    restore: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'
  },
  {
    table: 'workspace_search_documents',
    name: 'workspace_search_documents_source_check',
    restore: `CHECK (
      (kind = 'bookmark' AND bookmark_id IS NOT NULL AND note_id IS NULL)
      OR (kind = 'note' AND note_id IS NOT NULL AND bookmark_id IS NULL)
    )`
  },
  {
    table: 'workspace_search_documents',
    name: 'workspace_search_documents_embedding_check',
    restore: `CHECK (
      (embedding IS NULL AND embedding_model IS NULL
        AND embedding_dimensions IS NULL AND embedding_updated_at IS NULL)
      OR (
        embedding IS NOT NULL AND embedding_model IS NOT NULL
        AND embedding_dimensions IS NOT NULL
        AND embedding_dimensions BETWEEN 1 AND 4096
        AND cardinality(embedding) = embedding_dimensions
        AND embedding_updated_at IS NOT NULL
      )
    )`
  },
  {
    table: 'note_reminder_push_deliveries',
    name: 'note_reminder_push_deliveries_subscription_id_fkey',
    restore: 'FOREIGN KEY (subscription_id) REFERENCES web_push_subscriptions(id) ON DELETE CASCADE'
  },
  {
    table: 'notes',
    name: 'notes_rich_content_state_check',
    restore: `CHECK (
      (content_format = 'plain' AND content_json IS NULL AND content_json_encrypted IS NULL)
      OR (content_format = 'tiptap-json' AND encrypted = FALSE
        AND content_json IS NOT NULL AND content_json_encrypted IS NULL)
      OR (content_format = 'tiptap-json' AND encrypted = TRUE
        AND content_json IS NULL AND NULLIF(content_json_encrypted, '') IS NOT NULL)
    )`
  },
  {
    table: 'note_versions',
    name: 'note_versions_rich_content_state_check',
    restore: `CHECK (
      (content_format = 'plain' AND content_json IS NULL AND content_json_encrypted IS NULL)
      OR (content_format = 'tiptap-json' AND encrypted = FALSE
        AND content_json IS NOT NULL AND content_json_encrypted IS NULL)
      OR (content_format = 'tiptap-json' AND encrypted = TRUE
        AND content_json IS NULL AND NULLIF(content_json_encrypted, '') IS NOT NULL)
    )`
  }
]

function runVerifier() {
  return spawnSync(process.execPath, ['src/db/verifyMigrations.js'], {
    cwd: apiRoot,
    env: process.env,
    encoding: 'utf8'
  })
}

test('advanced feature migration verification fails closed for critical schema drift', {
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
        const verification = runVerifier()
        assert.notEqual(
          verification.status,
          0,
          `${constraint.name} drift unexpectedly passed verification`
        )
        assert.match(
          `${verification.stdout}\n${verification.stderr}`,
          /hybrid workspace search constraints|workspace search index state constraints|Web Push constraints|block editor constraints|foreign key/
        )
      } finally {
        await pool.query(
          `ALTER TABLE ${constraint.table} ADD CONSTRAINT ${constraint.name} ${constraint.restore}`
        )
      }
    }

    await pool.query('ALTER TABLE notes DISABLE TRIGGER notes_workspace_search_dirty')
    try {
      const verification = runVerifier()
      assert.notEqual(verification.status, 0, 'disabled dirty trigger unexpectedly passed')
      assert.match(
        `${verification.stdout}\n${verification.stderr}`,
        /dirty triggers must be enabled/
      )
    } finally {
      await pool.query('ALTER TABLE notes ENABLE TRIGGER notes_workspace_search_dirty')
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
