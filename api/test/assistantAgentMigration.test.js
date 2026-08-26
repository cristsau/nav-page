import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('assistant operation migration keeps idempotency metadata without content or secrets', async () => {
  const migration = await readFile(
    new URL('../src/db/migrations/033_assistant_agent_operations.sql', import.meta.url),
    'utf8'
  )
  const verifier = await readFile(new URL('../src/db/verifyMigrations.js', import.meta.url), 'utf8')

  assert.match(migration, /PRIMARY KEY \(user_id, operation_id\)/)
  assert.match(migration, /arguments_hash CHAR\(64\)/)
  assert.match(migration, /conversation_id UUID REFERENCES assistant_conversations/)
  assert.match(migration, /message_id UUID REFERENCES assistant_messages/)
  assert.match(migration, /response_message_id UUID REFERENCES assistant_messages/)
  assert.match(migration, /idx_assistant_agent_operations_response_message/)
  assert.match(migration, /undo_until TIMESTAMPTZ/)
  assert.doesNotMatch(migration, /arguments_json|request_body|response_body|api_key|password|secret/i)
  assert.match(verifier, /verifyAssistantAgentOperationsSchema/)
  assert.match(verifier, /assistant_agent_operations_message_id_fkey/)
  assert.match(verifier, /assistant_agent_operations_response_message_id_fkey/)
})
