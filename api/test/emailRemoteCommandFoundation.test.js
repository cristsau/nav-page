import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function source(relativePath) {
  return fs.readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('migration 041 creates an ownership-bound idempotent remote command outbox', async () => {
  const migration = await source('../src/db/migrations/041_email_remote_commands.sql')
  for (const fragment of [
    'CREATE TABLE email_remote_commands',
    'email_folder_messages_identity_account_user_unique',
    'source_location_id, account_id, user_id',
    'REFERENCES email_folder_messages(id, account_id, user_id)',
    'UNIQUE (user_id, idempotency_key)',
    "'mark_read', 'mark_unread', 'star', 'unstar'",
    "'archive', 'move', 'trash', 'delete'",
    "'scheduled', 'running', 'retry_wait', 'succeeded'",
    'undo_until',
    'remote_mutation_started_at',
    'permanent_confirmed_at',
    "VALUES ('email_remote_commands')"
  ]) assert.match(migration, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  assert.doesNotMatch(migration, /envelope|subject|body|password|token/i)
})

test('mailbox API exposes remote concurrency tokens and honest command lifecycle routes', async () => {
  const routes = await source('../src/routes/email.js')
  assert.match(routes, /remote:\s*\{[\s\S]*uidValidity:[\s\S]*uid:[\s\S]*modseq:/)
  assert.match(routes, /flags:\s*\{[\s\S]*deleted:/)
  assert.match(routes, /\/email\/accounts\/:accountId\/messages\/:locationId\/commands/)
  assert.match(routes, /\/email\/commands\/:commandId\/undo/)
  assert.match(routes, /\/email\/commands\/:commandId/)
  assert.match(routes, /reply\.code\(202\)/)
  assert.match(routes, /idempotentReplay/)
})

test('worker checks UIDVALIDITY and MODSEQ before mutation and never blindly retries move/delete', async () => {
  const worker = await source('../src/lib/emailRemoteCommandWorker.js')
  const policy = await source('../src/lib/emailRemoteCommandPolicy.js')
  for (const fragment of [
    'fetchOne',
    'compareEmailRemoteSnapshot',
    'unchangedSince',
    'messageFlagsAdd',
    'messageFlagsRemove',
    'messageMove',
    'messageDelete',
    'resolveImapAuth',
    'imapOauthProvider',
    'remote_mutation_started_at',
    'REMOTE_COMMAND_RESULT_UNKNOWN',
    'status = \'succeeded\'',
    'EMAIL_MAILBOX_CHANGE_CHANNEL'
  ]) assert.match(worker, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(policy, /mutationStarted && !FLAG_ACTIONS\.has\(action\).*'conflict'/)
  assert.match(worker, /recordSecurityEvent/)
})

test('remote command worker is retained by the dedicated mail runtime and migration verifier', async () => {
  const [runtime, maintenance, verifier, security] = await Promise.all([
    source('../src/lib/emailRuntimeController.js'),
    source('../src/lib/maintenanceJobStatus.js'),
    source('../src/db/verifyMigrations.js'),
    source('../src/lib/securityEvents.js')
  ])
  assert.match(runtime, /workerRuntimeEnabled[\s\S]+startEmailRemoteCommandScheduler/)
  assert.match(runtime, /enabled: config\.emailIngestEnabled/)
  assert.match(maintenance, /EMAIL_REMOTE_COMMANDS: 'email_remote_commands'/)
  assert.match(verifier, /verifyEmailRemoteCommandSchema/)
  assert.match(verifier, /await verifyEmailRemoteCommandSchema\(\)/)
  for (const event of [
    'email.remote_command.queued',
    'email.remote_command.cancelled',
    'email.remote_command.executed',
    'email.remote_command.failed',
    'email.remote_command.conflict'
  ]) assert.match(security, new RegExp(event.replaceAll('.', '\\.')))
})
