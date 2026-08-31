import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migrationUrl = new URL(
  '../src/db/migrations/042_email_ingest_pipeline.sql',
  import.meta.url
)
const verifierUrl = new URL('../src/db/verifyMigrations.js', import.meta.url)
const classificationWorkerUrl = new URL('../src/lib/emailClassificationWorker.js', import.meta.url)
const runtimeUrl = new URL('../src/lib/emailRuntimeController.js', import.meta.url)
const maintenanceUrl = new URL('../src/lib/maintenanceJobStatus.js', import.meta.url)

test('email ingest pipeline migration keeps queue payload identity-only and owner-bound', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  const queueDefinition = migration.match(
    /CREATE TABLE IF NOT EXISTS email_classification_jobs \(([\s\S]*?)\n\);/
  )?.[1] || ''
  assert.ok(queueDefinition)
  assert.match(migration, /sync_request_generation BIGINT NOT NULL DEFAULT 0/)
  assert.match(migration, /sync_completed_generation BIGINT NOT NULL DEFAULT 0/)
  assert.match(migration, /sync_completed_generation <= sync_request_generation/)
  assert.match(queueDefinition, /FOREIGN KEY \(account_id, user_id\)[\s\S]*REFERENCES email_accounts\(id, user_id\) ON DELETE CASCADE/)
  assert.match(queueDefinition, /FOREIGN KEY \(email_message_id, account_id, user_id\)[\s\S]*REFERENCES email_messages\(id, account_id, user_id\) ON DELETE CASCADE/)
  assert.match(queueDefinition, /UNIQUE \(user_id, email_message_id\)/)
  assert.match(queueDefinition, /status = 'succeeded' AND completed_at IS NOT NULL AND last_error_code IS NULL/)
  assert.match(queueDefinition, /status = 'dead_letter' AND completed_at IS NOT NULL AND last_error_code IS NOT NULL/)
  assert.match(queueDefinition, /status IN \('pending', 'running', 'retry_wait'\) AND completed_at IS NULL/)
  assert.doesNotMatch(queueDefinition, /subject|sender|recipient|body|content|envelope|password|secret|token/i)
  assert.match(migration, /WHERE NOT EXISTS \([\s\S]*FROM email_events/)
  assert.match(
    migration,
    /OR EXISTS \([\s\S]*notification_action IN \('immediate', 'in_app_only'\)[\s\S]*notified_at IS NULL/
  )
  assert.match(migration, /ON CONFLICT \(user_id, email_message_id\) DO NOTHING/)
  assert.match(migration, /VALUES \('email_classification'\)/)
})

test('migration verifier and runtime wire the classification queue and observability', async () => {
  const [verifier, classificationWorker, runtime, maintenance] = await Promise.all([
    readFile(verifierUrl, 'utf8'),
    readFile(classificationWorkerUrl, 'utf8'),
    readFile(runtimeUrl, 'utf8'),
    readFile(maintenanceUrl, 'utf8')
  ])
  assert.match(verifier, /async function verifyEmailIngestPipelineSchema\(\)/)
  assert.match(verifier, /email_accounts_sync_generation_check/)
  assert.match(verifier, /email_classification_jobs_message_account_user_fkey/)
  assert.match(verifier, /\(status\)::text = 'succeeded'::text/)
  assert.match(verifier, /\(status\)::text = 'dead_letter'::text/)
  assert.match(verifier, /email classification job constraints must be validated/)
  assert.match(verifier, /idx_email_classification_jobs_due/)
  assert.match(verifier, /await verifyEmailIngestPipelineSchema\(\)/)
  assert.match(classificationWorker, /SET status = \$2::varchar\(16\)/)
  assert.match(classificationWorker, /last_error_code = \$5::varchar\(64\)/)
  assert.match(runtime, /startEmailClassificationScheduler/)
  assert.match(runtime, /emailClassificationIntervalSeconds/)
  assert.match(runtime, /drainMaxMilliseconds: config\.imapDrainMaxMilliseconds/)
  assert.match(maintenance, /EMAIL_CLASSIFICATION: 'email_classification'/)
  assert.match(maintenance, /'dueRemaining'/)
})
