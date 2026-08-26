import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('workspace search dirty trigger preserves indexing while allowing user cascades', async () => {
  const migration = await readFile(
    new URL('../src/db/migrations/034_workspace_search_user_cascade.sql', import.meta.url),
    'utf8'
  )
  const verifier = await readFile(
    new URL('../src/db/verifyMigrations.js', import.meta.url),
    'utf8'
  )
  const integration = await readFile(
    new URL('../integration/releaseAcceptancePostgres.integration.js', import.meta.url),
    'utf8'
  )

  assert.match(migration, /CREATE OR REPLACE FUNCTION nav_mark_workspace_search_dirty\(\)/)
  assert.match(migration, /FROM users AS owner_user\s+WHERE owner_user\.id = NEW\.user_id/)
  assert.match(migration, /FROM users AS owner_user\s+WHERE owner_user\.id = OLD\.user_id/)
  assert.doesNotMatch(migration, /DISABLE TRIGGER|DROP CONSTRAINT|session_replication_role/i)

  assert.match(verifier, /workspace search dirty trigger must guard deleted user cascades/)
  assert.match(integration, /Ephemeral bookmark/)
  assert.match(integration, /Ephemeral note/)
  assert.match(integration, /ephemeral_search_states: 0/)
})
