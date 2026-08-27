import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('mail API exposes authenticated AI, draft preview and explicit send routes', async () => {
  const route = await source('../src/routes/email.js')

  assert.match(route, /fastify\.post\('\/email\/messages\/:messageId\/ai'/)
  assert.match(route, /fastify\.post\('\/email\/drafts'/)
  assert.match(route, /fastify\.get\('\/email\/drafts\/:draftId'/)
  assert.match(route, /fastify\.post\('\/email\/drafts\/:draftId\/send'/)
  assert.match(route, /contentHash: request\.body\?\.contentHash/)
  assert.match(route, /confirmed: request\.body\?\.confirm/)
  assert.match(route, /eventType: 'email\.send\.queued'/)
  assert.match(route, /reply\.code\(202\)/)
  assert.match(route, /Object\.hasOwn\(EMAIL_AI_ACTIONS, action\)/)
  assert.match(route, /EMAIL_AI_MESSAGE_ACTIONS\.has\(action\)/)
  assert.match(route, /fastify\.post\('\/email\/ai\/search'/)
  assert.match(route, /fastify\.post\('\/email\/messages\/:messageId\/ai\/proposals'/)
  assert.match(route, /fastify\.post\('\/email\/messages\/:messageId\/ai\/confirm'/)
  assert.match(route, /verifyEmailAiConfirmationToken/)
  assert.match(route, /toolName: kind/)
  assert.match(route, /`\/mail\?draft=\$\{encodeURIComponent\(resourceId\)\}`/)
  assert.doesNotMatch(route, /create_note/)
  const aiRoutes = route.slice(
    route.indexOf("fastify.post('/email/messages/:messageId/ai'"),
    route.indexOf("fastify.post('/email/drafts'")
  )
  assert.doesNotMatch(aiRoutes, /queueEmailDraft\(/)
  assert.doesNotMatch(aiRoutes, /enqueueUserMail\(/)
  assert.doesNotMatch(aiRoutes, /DELETE FROM email_messages|UPDATE email_folder_messages SET.*deleted/is)
  assert.match(route, /matchValue = 'current-thread'/)
})

test('AI draft confirmation reuses the operation transaction without a nested transaction', async () => {
  const drafts = await source('../src/lib/emailDrafts.js')
  const helper = drafts.slice(
    drafts.indexOf('export async function createEmailDraftInTransaction'),
    drafts.indexOf('export async function createEmailDraft({')
  )
  assert.match(helper, /client\.query/)
  assert.match(helper, /INSERT INTO email_drafts/)
  assert.doesNotMatch(helper, /client\.query\('BEGIN'\)|client\.query\('COMMIT'\)/)
})

test('mailbox ingestion failure state is scoped by source and owner', async () => {
  const scheduler = await source('../src/lib/emailIngestScheduler.js')

  assert.match(scheduler, /UPDATE_MAILBOX_FAILURE_STATE_SQL/)
  assert.match(scheduler, /state\.source_key = \$1/)
  assert.match(scheduler, /state\.user_id = owner\.id/)
  assert.match(scheduler, /owner\.username = \$2/)
  assert.doesNotMatch(scheduler, /WHERE source_key = \$1`/)
})

test('draft queue requires exact confirmation and immutable preview hash', async () => {
  const drafts = await source('../src/lib/emailDrafts.js')

  assert.match(drafts, /confirmed !== true/)
  assert.match(drafts, /Explicit email send confirmation is required/)
  assert.match(drafts, /HASH_PATTERN\.test\(expectedHash\)/)
  assert.match(drafts, /row\.content_hash !== expectedHash/)
  assert.match(drafts, /preview it again before sending/)
  assert.match(drafts, /SELECT \* FROM email_drafts[\s\S]*FOR UPDATE/)
  assert.match(drafts, /status = 'queued', outbox_id = \$3, confirmed_at = NOW\(\)/)
})

test('user mail outbox stores only ciphertext and scrubs it after terminal delivery', async () => {
  const outbox = await source('../src/lib/mailOutbox.js')
  const enqueue = outbox.slice(
    outbox.indexOf('export async function enqueueUserMail'),
    outbox.indexOf('async function createSmtpTransport')
  )

  assert.match(enqueue, /encryptPayloadFn\(normalized/)
  assert.match(enqueue, /payload_encrypted, content_hash, confirmed_at/)
  assert.match(enqueue, /'redacted@invalid\.local', '\[加密用户邮件\]', '', ''/)
  assert.doesNotMatch(enqueue, /normalized\.(?:to|cc|bcc|subject|text)/)
  assert.match(outbox, /payload_encrypted = NULL/)
  assert.match(outbox, /Encrypted user mail payload hash mismatch/)
  assert.match(outbox, /if \(smtpAccepted\)/)
  assert.match(outbox, /AMBIGUOUS_DELIVERY_STATE/)
  assert.doesNotMatch(outbox, /STALE_DELIVERY_LEASE/)
})

test('mail composer enforces save-review-confirm-send as two distinct actions', async () => {
  const [api, dialog] = await Promise.all([
    source('../../app/src/shared/services/emailApi.js'),
    source('../../app/src/modules/mail/components/MailComposeDialog.vue')
  ])

  assert.match(api, /export function createEmailDraft/)
  assert.match(api, /export function fetchEmailDraft/)
  assert.match(api, /export function confirmEmailDraft/)
  assert.match(api, /confirm: true[\s\S]*contentHash/)
  assert.match(dialog, /async function saveAndReview\(\)/)
  assert.match(dialog, /stage\.value = 'review'/)
  assert.match(dialog, /v-model="confirmed" type="checkbox"/)
  assert.match(dialog, /async function sendConfirmedDraft\(\)/)
  assert.match(dialog, /confirmEmailDraft\(draftId\.value, contentHash\.value\)/)
  assert.match(dialog, /保存只会生成加密草稿/)
  assert.match(dialog, /确认将这封邮件发送到外部邮箱/)
  assert.match(dialog, /const canonicalPayload = draft\?\.payload/)
  assert.doesNotMatch(api, /reasoningEffort|model = ''/)
})
