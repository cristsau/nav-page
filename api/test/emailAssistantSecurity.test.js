import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  decryptEmailPayloadWithKey,
  encryptEmailPayloadWithKey
} from '../src/lib/emailCrypto.js'
import { prepareAssistantAnswerForStorage } from '../src/routes/assistant.js'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('email payload encryption uses authenticated ciphertext and rejects the wrong key', () => {
  const key = randomBytes(32)
  const payload = {
    subject: '安全提醒',
    text: '正文中可能包含敏感内容',
    senderAddress: 'security@example.test'
  }
  const encrypted = encryptEmailPayloadWithKey(payload, key, { context: 'user-a:mxroute' })

  assert.notEqual(encrypted.includes(Buffer.from(payload.subject)), true)
  assert.deepEqual(
    decryptEmailPayloadWithKey(encrypted, key, { context: 'user-a:mxroute' }),
    payload
  )
  assert.throws(
    () => decryptEmailPayloadWithKey(encrypted, randomBytes(32), { context: 'user-a:mxroute' }),
    /authenticate|Unsupported state|unable/i
  )
  assert.throws(
    () => decryptEmailPayloadWithKey(encrypted, key, { context: 'user-b:mxroute' }),
    /authenticate|Unsupported state|unable/i
  )
})

test('registration verification token stays out of server-visible query strings', async () => {
  const [delivery, authUi] = await Promise.all([
    source('../src/lib/notificationDelivery.js'),
    source('../../app/src/modules/auth/AuthView.vue')
  ])
  assert.match(delivery, /#register-verify\?/)
  assert.doesNotMatch(delivery, /\/auth\?\$\{query\.toString\(\)\}/)
  assert.match(authUi, /window\.location\.hash/)
  assert.match(authUi, /history\.replaceState/)
})

test('mail and notification surfaces keep secrets server-side and Web Push generic', async () => {
  const [env, compose, push, emailRoute, assistantRoute] = await Promise.all([
    source('../.env.example'),
    source('../../docker-compose.backend.yml'),
    source('../src/lib/webPushScheduler.js'),
    source('../src/routes/email.js'),
    source('../src/routes/assistant.js')
  ])
  assert.match(env, /NAV_SMTP_PASSWORD_FILE=\/run\/secrets\/nav\/smtp-password/)
  assert.match(env, /NAV_EMAIL_ENCRYPTION_KEY_FILE=\/run\/secrets\/nav\/email-encryption-key/)
  assert.doesNotMatch(env, /NAV_SMTP_PASSWORD=/)
  assert.match(compose, /smtp-password:\/run\/secrets\/nav\/smtp-password:ro/)
  assert.match(compose, /email-encryption-key:\/run\/secrets\/nav\/email-encryption-key:ro/)
  assert.match(push, /你有一条新的重要提醒，登录后查看完整内容/)
  assert.match(push, /candidate\.sensitive \? '\/\?notifications=1'/)
  assert.match(push, /你有一条新的到期提醒，登录后查看完整内容/)
  assert.doesNotMatch(push, /candidate\.title|candidate\.number_id/)
  assert.doesNotMatch(emailRoute, /imapPassword(?!File)|smtpPassword(?!File)|apiKey\s*:/)
  assert.match(assistantRoute, /webSearchEnabled: false/)
})

test('mail ingestion ignores attachments and bounds source/body sizes', async () => {
  const [ingest, classifier, privacy, migration] = await Promise.all([
    source('../src/lib/emailIngestScheduler.js'),
    source('../src/lib/emailClassifier.js'),
    source('../src/lib/emailPrivacy.js'),
    source('../src/db/migrations/030_email_assistant.sql')
  ])
  assert.match(ingest, /attachments/i)
  assert.match(ingest, /maxMessageBytes/)
  assert.match(privacy, /\[OTP_REDACTED\]/)
  assert.match(privacy, /\[LINK_REDACTED\]/)
  assert.match(privacy, /\[EMAIL_REDACTED\]/)
  assert.match(privacy, /\[PHONE_REDACTED\]/)
  assert.match(privacy, /\[NUMERIC_CODE_REDACTED\]/)
  assert.match(classifier, /AI 暂不可用.*Tier 2/s)
  assert.match(migration, /content_encrypted BYTEA NOT NULL/)
  assert.doesNotMatch(migration, /subject\s+TEXT|body\s+TEXT|sender_address\s+TEXT/i)
})

test('registration resend rotates the token and SMTP is constrained to implicit TLS', async () => {
  const [authRoute, delivery, mailOutbox, migration] = await Promise.all([
    source('../src/routes/auth.js'),
    source('../src/lib/notificationDelivery.js'),
    source('../src/lib/mailOutbox.js'),
    source('../src/db/migrations/029_notifications_mail_registration.sql')
  ])
  assert.match(authRoute, /\/auth\/register\/resend-verification/)
  assert.match(authRoute, /verification_sent_at <= NOW\(\) - INTERVAL '60 seconds'/)
  assert.match(delivery, /registration-verify:\$\{requestId\}:\$\{tokenDigest\}/)
  assert.match(mailOutbox, /SMTP must use implicit TLS on port 465/)
  assert.match(mailOutbox, /tls: \{ minVersion: 'TLSv1\.2', rejectUnauthorized: true \}/)
  assert.match(migration, /registration_requests_verification_state_check/)
  assert.match(migration, /idx_registration_requests_pending_email_unique/)
})

test('bounded email digest batches use distinct idempotency keys', async () => {
  const digest = await source('../src/lib/emailDigestScheduler.js')
  assert.match(digest, /const digestKey = `\$\{clock\.date\}-\$\{clock\.hour\}-\$\{ids\[0\]\}`/)
  assert.match(digest, /dedupeKey: `email-digest:\$\{digestKey\}`/)
  assert.doesNotMatch(digest, /dedupeKey: `email-digest:\$\{clock\.date\}:\$\{clock\.hour\}`/)
})

test('email-derived assistant history is encrypted and persists only generic source metadata', async () => {
  const [assistantRoute, migration, preferencesMigration, verifier] = await Promise.all([
    source('../src/routes/assistant.js'),
    source('../src/db/migrations/030_email_assistant.sql'),
    source('../src/db/migrations/031_assistant_chat_preferences.sql'),
    source('../src/db/verifyMigrations.js')
  ])
  assert.match(migration, /content_encrypted BYTEA/)
  assert.match(migration, /content_sensitive BOOLEAN NOT NULL DEFAULT FALSE/)
  assert.match(migration, /assistant_messages_sensitive_content_check/)
  assert.match(verifier, /assistant_messages_encrypted_content_size_check/)
  assert.match(assistantRoute, /containsEmail/)
  assert.match(assistantRoute, /\[邮件相关回答已加密\]/)
  assert.match(assistantRoute, /邮件来源（登录后打开查看）/)
  assert.match(assistantRoute, /encryptEmailPayload/)
  assert.match(assistantRoute, /decryptEmailPayload/)
  assert.match(preferencesMigration, /reasoning_effort/)
  assert.match(preferencesMigration, /model_mode/)
  assert.match(verifier, /assistant_conversations_reasoning_effort_check/)
})

test('advanced mail actions encrypt both user and assistant history while keeping generic plaintext', async () => {
  const key = randomBytes(32)
  const userId = '00000000-0000-4000-8000-000000000001'
  const conversationId = '00000000-0000-4000-8000-000000000002'
  const context = `assistant:${userId}:${conversationId}`
  const uniqueRecipient = 'private-recipient-advanced@example.test'
  const uniqueSubject = 'PRIVATE-ADVANCED-MAIL-SUBJECT-9137'
  const uniqueBody = 'PRIVATE-ADVANCED-MAIL-BODY-4271'
  const encryptPayloadFn = async (payload, options) => encryptEmailPayloadWithKey(
    payload,
    key,
    options
  )

  const userStorage = await prepareAssistantAnswerForStorage({
    answer: `发送给 ${uniqueRecipient}，主题 ${uniqueSubject}，正文 ${uniqueBody}`,
    sources: [],
    userId,
    conversationId,
    forceSensitive: true,
    fallbackLabel: '邮件操作请求',
    encryptPayloadFn
  })
  const assistantStorage = await prepareAssistantAnswerForStorage({
    answer: `请确认向 ${uniqueRecipient} 发送 ${uniqueSubject}：${uniqueBody}`,
    sources: [],
    userId,
    conversationId,
    forceSensitive: true,
    fallbackLabel: '邮件操作回答',
    encryptPayloadFn
  })

  for (const stored of [userStorage, assistantStorage]) {
    assert.equal(stored.contentSensitive, true)
    assert.equal(Buffer.isBuffer(stored.contentEncrypted), true)
    assert.doesNotMatch(stored.content, /private-recipient|PRIVATE-ADVANCED/)
  }
  assert.equal(userStorage.content, '[邮件操作请求已加密]')
  assert.equal(assistantStorage.content, '[邮件操作回答已加密]')
  assert.match(
    decryptEmailPayloadWithKey(userStorage.contentEncrypted, key, { context }).content,
    /private-recipient-advanced@example\.test.*PRIVATE-ADVANCED-MAIL-SUBJECT-9137.*PRIVATE-ADVANCED-MAIL-BODY-4271/
  )
  assert.match(
    decryptEmailPayloadWithKey(assistantStorage.contentEncrypted, key, { context }).content,
    /private-recipient-advanced@example\.test.*PRIVATE-ADVANCED-MAIL-SUBJECT-9137.*PRIVATE-ADVANCED-MAIL-BODY-4271/
  )
})
