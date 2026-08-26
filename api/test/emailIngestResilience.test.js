import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  deriveEmailBatchSourceBudget,
  emailMessageFailureState,
  normalizeEmailMessageAttempts,
  truncateUtf8
} from '../src/lib/emailIngestLimits.js'
import { EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES } from '../src/lib/emailCrypto.js'
import { buildCanonicalMailboxMessage } from '../src/lib/emailMailboxStore.js'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('mail ingest source budget is explicit, bounded and larger than one message fetch', () => {
  assert.equal(deriveEmailBatchSourceBudget(512 * 1024), 4 * 1024 * 1024)
  assert.equal(deriveEmailBatchSourceBudget(2 * 1024 * 1024), 16 * 1024 * 1024)
  assert.equal(deriveEmailBatchSourceBudget(32 * 1024, Number.MAX_SAFE_INTEGER), 16 * 1024 * 1024)
  assert.equal(deriveEmailBatchSourceBudget(512 * 1024, 1), 512 * 1024 + 1)
})

test('message retry state is UID-scoped, finite and sanitized for persistence', () => {
  assert.equal(normalizeEmailMessageAttempts(0), 1)
  assert.equal(normalizeEmailMessageAttempts(99), 10)
  assert.deepEqual(
    emailMessageFailureState({ errorCode: null, uid: 42, maxAttempts: 3 }),
    { attempt: 1, deadLetter: false, code: 'EMAIL_UID_42_RETRY_1' }
  )
  assert.deepEqual(
    emailMessageFailureState({ errorCode: 'EMAIL_UID_42_RETRY_1', uid: 42, maxAttempts: 3 }),
    { attempt: 2, deadLetter: false, code: 'EMAIL_UID_42_RETRY_2' }
  )
  assert.deepEqual(
    emailMessageFailureState({ errorCode: 'EMAIL_UID_42_RETRY_2', uid: 42, maxAttempts: 3 }),
    { attempt: 3, deadLetter: true, code: 'EMAIL_UID_42_DEADLETTER' }
  )
  assert.deepEqual(
    emailMessageFailureState({ errorCode: 'EMAIL_UID_42_DEADLETTER', uid: 42, maxAttempts: 3 }),
    { attempt: 3, deadLetter: true, code: 'EMAIL_UID_42_DEADLETTER' }
  )
  assert.equal(
    emailMessageFailureState({ errorCode: 'EMAIL_UID_41_RETRY_2', uid: 42, maxAttempts: 3 }).attempt,
    1
  )
})

test('UTF-8 body truncation never splits a multi-byte character', () => {
  assert.equal(truncateUtf8('a你b', 4), 'a你')
  assert.equal(truncateUtf8('a你b', 3), 'a')
  assert.equal(Buffer.byteLength(truncateUtf8('你'.repeat(200_000), 400_000), 'utf8') <= 400_000, true)
})

test('scheduler-level metadata and text caps fit both encryption payloads', () => {
  const address = { name: '你'.repeat(320), address: `${'你'.repeat(300)}@example.test` }
  const canonical = buildCanonicalMailboxMessage({
    mailboxUid: 1,
    receivedAt: new Date('2026-08-26T00:00:00Z'),
    sender: address,
    to: Array.from({ length: 50 }, () => address),
    cc: Array.from({ length: 50 }, () => address),
    bcc: Array.from({ length: 50 }, () => address),
    references: Array.from({ length: 50 }, () => '你'.repeat(998)),
    text: truncateUtf8('你'.repeat(200_000), 400_000),
    attachments: Array.from({ length: 50 }, () => ({
      filename: '你'.repeat(240),
      contentType: '你'.repeat(120),
      contentDisposition: '你'.repeat(32),
      contentId: '你'.repeat(240),
      size: 1
    }))
  })

  assert.equal(
    Buffer.byteLength(JSON.stringify(canonical.envelope), 'utf8') < EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES,
    true
  )
  assert.equal(
    Buffer.byteLength(JSON.stringify(canonical.content), 'utf8') < EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES,
    true
  )
})

test('scheduler streams one bounded source at a time and clears it in finally', async () => {
  const scheduler = await source('../src/lib/emailIngestScheduler.js')

  assert.match(scheduler, /maxBatchSourceBytes: deriveEmailBatchSourceBudget/)
  assert.match(scheduler, /source: \{ start: 0, maxLength: fetchLimit \}/)
  assert.match(scheduler, /sourceBytes \+ fetchLimit > validated\.maxBatchSourceBytes/)
  assert.match(scheduler, /if \(Buffer\.isBuffer\(message\.source\)\) message\.source\.fill\(0\)/)
  assert.doesNotMatch(scheduler, /fetchAll\([\s\S]{0,180}source:\s*true/)
  assert.match(scheduler, /if \(!sourceBudgetExhausted && candidateEndUid != null\)/)
})

test('message poison handling leaves an encrypted location marker before cursor progress', async () => {
  const scheduler = await source('../src/lib/emailIngestScheduler.js')
  const failureAt = scheduler.indexOf('emailMessageFailureState({')
  const markerAt = scheduler.indexOf('await markDeadLetter(stored)', failureAt)
  const cursorAt = scheduler.indexOf('await writeMailboxState({ uid, errorCode: failure.code })', markerAt)

  assert.ok(failureAt > 0 && markerAt > failureAt && cursorAt > markerAt)
  assert.match(scheduler, /\$nav-ingest-dead-letter/)
  assert.match(scheduler, /String\(previousMailboxState\.uid_validity \|\| ''\) === uidValidity/)
  assert.match(scheduler, /placeholder\.text = '\[此邮件无法安全处理/)
  assert.doesNotMatch(scheduler, /logger\?\.(?:warn|error)\?\.\(\{[^}]*message\.source/s)
})

test('stale folders are hidden only after a successful authoritative LIST', async () => {
  const scheduler = await source('../src/lib/emailIngestScheduler.js')
  const successAt = scheduler.indexOf('folderCatalogSucceeded = true')
  const guardAt = scheduler.indexOf('if (folderCatalogSucceeded)', successAt)
  const updateAt = scheduler.indexOf('SET selectable = FALSE, subscribed = FALSE', guardAt)

  assert.ok(successAt > 0 && guardAt > successAt && updateAt > guardAt)
  assert.match(scheduler, /AND path <> \$3/)
  assert.match(scheduler, /NOT \(path = ANY\(\$4::text\[\]\)\)/)
})
