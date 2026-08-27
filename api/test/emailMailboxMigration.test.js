import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL(
  '../src/db/migrations/035_email_mailbox_foundation.sql',
  import.meta.url
)
const smartMailMigrationUrl = new URL(
  '../src/db/migrations/036_email_ai_drafts_retention.sql',
  import.meta.url
)
const attachmentMigrationUrl = new URL(
  '../src/db/migrations/037_email_attachments_sent_sync.sql',
  import.meta.url
)
const sentAppendMigrationUrl = new URL(
  '../src/db/migrations/038_email_sent_append_jobs.sql',
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

test('smart mail migration scopes mailbox cursors per user and stores encrypted drafts', async () => {
  const migration = await readFile(smartMailMigrationUrl, 'utf8')

  assert.match(
    migration,
    /ADD CONSTRAINT email_mailbox_state_pkey PRIMARY KEY \(user_id, source_key\)/
  )
  assert.match(migration, /CREATE TABLE IF NOT EXISTS email_drafts \(/)
  assert.match(migration, /payload_encrypted BYTEA NOT NULL/)
  assert.match(migration, /content_hash CHAR\(64\) NOT NULL/)
  assert.match(migration, /FOREIGN KEY \(account_id, user_id\)[\s\S]*REFERENCES email_accounts\(id, user_id\) ON DELETE CASCADE/)
  assert.match(migration, /status IN \('draft', 'queued', 'sent', 'failed'\)/)
  assert.match(migration, /status = 'queued' AND confirmed_at IS NOT NULL AND outbox_id IS NOT NULL/)
  assert.doesNotMatch(migration, /\n\s*(?:to|cc|bcc|subject|body|text_body|html_body)\s+(?:TEXT|VARCHAR)/i)
})

test('smart mail outbox requires encrypted confirmed user payloads and bounded retention', async () => {
  const [migration, verifier] = await Promise.all([
    readFile(smartMailMigrationUrl, 'utf8'),
    readFile(verifierUrl, 'utf8')
  ])

  for (const column of [
    'user_id UUID',
    'account_id UUID',
    'payload_encrypted BYTEA',
    'content_hash CHAR(64)',
    'confirmed_at TIMESTAMPTZ'
  ]) {
    assert.match(migration, new RegExp(column.replace(/[()]/g, '\\$&')))
  }
  assert.match(migration, /message_type <> 'user\.mail'[\s\S]*confirmed_at IS NOT NULL[\s\S]*sensitive = TRUE/)
  assert.match(migration, /status IN \('pending', 'sending', 'failed'\)[\s\S]*payload_encrypted IS NOT NULL/)
  assert.match(migration, /status IN \('sent', 'expired'\)[\s\S]*payload_encrypted IS NULL/)
  assert.match(migration, /octet_length\(payload_encrypted\) BETWEEN 32 AND 1048576/)
  assert.match(migration, /VALUES \('email_cache_retention'\)/)
  assert.match(verifier, /email_drafts_outbox_id_key/)
  assert.match(verifier, /email draft outbox unique binding/)
  assert.match(verifier, /unique \(outbox_id\)/)
})

test('email attachment migration stores owner-bound encrypted chunks with lifecycle limits', async () => {
  const migration = await readFile(attachmentMigrationUrl, 'utf8')

  for (const table of ['email_attachment_objects', 'email_attachment_chunks']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`))
  }
  assert.match(migration, /FOREIGN KEY \(draft_id, user_id\)[\s\S]*REFERENCES email_drafts\(id, user_id\) ON DELETE CASCADE/)
  assert.match(migration, /FOREIGN KEY \(outbox_id, user_id\)[\s\S]*REFERENCES mail_outbox\(id, user_id\) ON DELETE CASCADE/)
  assert.match(migration, /FOREIGN KEY \(attachment_id, user_id\)[\s\S]*REFERENCES email_attachment_objects\(id, user_id\) ON DELETE CASCADE/)
  assert.match(migration, /state IN \('draft', 'claimed', 'scrubbed'\)/)
  assert.match(migration, /size_bytes BETWEEN 1 AND 10485760/)
  assert.match(migration, /chunk_count BETWEEN 1 AND 40/)
  assert.match(migration, /plaintext_size BETWEEN 1 AND 262144/)
  assert.match(migration, /octet_length\(ciphertext_encrypted\) = plaintext_size \+ 29/)
  assert.match(migration, /state = 'scrubbed'[\s\S]*metadata_encrypted IS NULL[\s\S]*scrubbed_at IS NOT NULL/)
  assert.match(migration, /UNIQUE \(id, user_id\)/)
  assert.doesNotMatch(migration, /\n\s*(?:filename|content_type|content_id|content)\s+(?:TEXT|VARCHAR|BYTEA)/i)
})

test('migration verifier validates attachment columns, constraints and partial indexes', async () => {
  const verifier = await readFile(verifierUrl, 'utf8')

  assert.match(verifier, /async function verifyEmailAttachmentSchema\(\)/)
  assert.match(verifier, /email_attachment_objects_lifecycle_check/)
  assert.match(verifier, /email_attachment_chunks_ciphertext_size_check/)
  assert.match(verifier, /idx_email_attachment_objects_outbox_ordinal/)
  assert.match(verifier, /idx_email_attachment_objects_user_staged/)
  assert.match(verifier, /constraints must be validated/)
  assert.match(verifier, /await verifyEmailAttachmentSchema\(\)/)
})

test('Sent append migration preserves encrypted MIME until a terminal lifecycle state', async () => {
  const migration = await readFile(sentAppendMigrationUrl, 'utf8')

  assert.match(migration, /CREATE TABLE IF NOT EXISTS email_sent_append_jobs \(/)
  assert.match(migration, /FOREIGN KEY \(outbox_id, user_id\)[\s\S]*REFERENCES mail_outbox\(id, user_id\) ON DELETE CASCADE/)
  assert.match(migration, /FOREIGN KEY \(account_id, user_id\)[\s\S]*REFERENCES email_accounts\(id, user_id\) ON DELETE CASCADE/)
  assert.match(migration, /status VARCHAR\(16\) NOT NULL DEFAULT 'prepared'/)
  assert.match(migration, /mime_encrypted BYTEA/)
  assert.match(migration, /mime_size_bytes BETWEEN 1 AND 41943040/)
  assert.match(migration, /sent_folder_path IS NULL[\s\S]*char_length\(sent_folder_path\) BETWEEN 1 AND 512[\s\S]*\[:cntrl:\]/)
  assert.match(migration, /uid_validity IS NULL OR uid_validity BETWEEN 1 AND 4294967295/)
  assert.match(migration, /uid IS NULL OR uid BETWEEN 1 AND 4294967295/)
  assert.match(migration, /last_error_code IS NULL OR last_error_code ~ '\^\[A-Z0-9_\.\-\]\+\$'/)
  assert.match(migration, /append_attempted = FALSE[\s\S]*append_attempt_count = 0[\s\S]*append_started_at IS NULL/)
  assert.match(migration, /append_attempted = TRUE[\s\S]*append_attempt_count >= 1[\s\S]*append_started_at IS NOT NULL/)
  assert.match(migration, /status = 'appended'[\s\S]*mime_encrypted IS NULL[\s\S]*sent_folder_path IS NOT NULL[\s\S]*uid_validity IS NOT NULL[\s\S]*uid IS NOT NULL[\s\S]*scrubbed_at IS NOT NULL/)
  assert.match(migration, /WHERE status IN \('pending', 'appending', 'reconcile', 'blocked'\)/)
  assert.match(migration, /VALUES \('email_sent_append'\)/)
})

test('migration verifier validates Sent append types, defaults and remote identity guards', async () => {
  const verifier = await readFile(verifierUrl, 'utf8')

  assert.match(verifier, /async function verifyEmailSentAppendSchema\(\)/)
  assert.match(verifier, /email Sent append critical columns/)
  assert.match(verifier, /expectedDefault === null/)
  assert.match(verifier, /email_sent_append_jobs_folder_path_check/)
  assert.match(verifier, /email_sent_append_jobs_uid_validity_check/)
  assert.match(verifier, /email_sent_append_jobs_uid_check/)
  assert.match(verifier, /email_sent_append_jobs_error_code_check/)
  assert.match(verifier, /append_attempt_count = 0/)
  assert.match(verifier, /append_attempt_count >= 1/)
  assert.match(verifier, /append_started_at is null/)
  assert.match(verifier, /append_started_at is not null/)
  assert.match(verifier, /\(next_attempt_at, created_at, id\)/)
  assert.match(verifier, /\(user_id, created_at desc, id\)/)
  assert.match(verifier, /await verifyEmailSentAppendSchema\(\)/)
})
