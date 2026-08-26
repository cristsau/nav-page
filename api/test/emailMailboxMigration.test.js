import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL(
  '../src/db/migrations/035_email_mailbox_foundation.sql',
  import.meta.url
)
const verifierUrl = new URL('../src/db/verifyMigrations.js', import.meta.url)

test('mailbox foundation models accounts, folders, messages and remote identities', async () => {
  const migration = await readFile(migrationUrl, 'utf8')

  for (const table of [
    'email_accounts',
    'email_folders',
    'email_messages',
    'email_folder_messages'
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`))
  }

  assert.match(migration, /UNIQUE \(user_id, source_key\)/)
  assert.match(
    migration,
    /FOREIGN KEY \(account_id, user_id\)[\s\S]*REFERENCES email_accounts\(id, user_id\) ON DELETE CASCADE/
  )
  assert.match(
    migration,
    /FOREIGN KEY \(folder_id, account_id, user_id\)[\s\S]*REFERENCES email_folders\(id, account_id, user_id\) ON DELETE CASCADE/
  )
  assert.match(
    migration,
    /FOREIGN KEY \(message_id, account_id, user_id\)[\s\S]*REFERENCES email_messages\(id, account_id, user_id\) ON DELETE CASCADE/
  )
  assert.match(migration, /UNIQUE \(folder_id, uid_validity, uid\)/)
  assert.match(migration, /uid_validity BETWEEN 1 AND 4294967295/)
  assert.match(migration, /uid BETWEEN 1 AND 4294967295/)
  assert.match(migration, /NUMERIC\(20, 0\)/)
  assert.match(migration, /18446744073709551615/)
  assert.match(migration, /special_use IN \([\s\S]*'sent'[\s\S]*'drafts'[\s\S]*'trash'/)
  assert.match(migration, /WHERE expunged_at IS NULL AND seen = FALSE/)
  assert.match(migration, /WHERE expunged_at IS NULL AND flagged = TRUE/)
})

test('mailbox foundation links classifications without storing mailbox credentials', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  const accountDefinition = migration.match(
    /CREATE TABLE IF NOT EXISTS email_accounts \(([\s\S]*?)\n\);/
  )?.[1] || ''

  assert.ok(accountDefinition)
  assert.doesNotMatch(accountDefinition, /password|secret|token|credential/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS email_message_id UUID/)
  assert.match(
    migration,
    /FOREIGN KEY \(email_message_id, user_id\)[\s\S]*REFERENCES email_messages\(id, user_id\) ON DELETE CASCADE/
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_email_events_user_message_unique[\s\S]*WHERE email_message_id IS NOT NULL/
  )
  assert.doesNotMatch(migration, /ALTER TABLE mail_outbox/)
})

test('migration verifier checks mailbox definitions instead of names alone', async () => {
  const verifier = await readFile(verifierUrl, 'utf8')

  assert.match(verifier, /async function verifyEmailMailboxSchema\(\)/)
  assert.match(verifier, /pg_get_constraintdef\(oid\) AS definition/)
  assert.match(verifier, /SELECT indexname, indexdef/)
  assert.match(verifier, /email_folder_messages_remote_identity_unique/)
  assert.match(verifier, /email_folder_messages_folder_account_user_fkey/)
  assert.match(verifier, /email_folder_messages_message_account_user_fkey/)
  assert.match(verifier, /email_events_message_user_fkey/)
  assert.match(verifier, /expectedType === 'numeric'/)
  assert.match(verifier, /await verifyEmailMailboxSchema\(\)/)
})
