import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(relativeUrl) {
  return (await readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n')
}

test('mail workspace acceptance is ephemeral, dual-origin and secret-file based', async () => {
  const shell = await source('../../scripts/release/accept-mail-workspace.sh')

  assert.match(shell, /set -Eeuo pipefail/)
  assert.match(shell, /set \+x/)
  assert.match(shell, /umask 077/)
  assert.match(shell, /NAV_ACCEPTANCE_EPHEMERAL/)
  assert.match(shell, /NAV_ACCEPTANCE_USERNAME_FILE/)
  assert.match(shell, /NAV_ACCEPTANCE_PASSWORD_FILE/)
  assert.match(shell, /jq -n[\s\S]*--rawfile username[\s\S]*--rawfile password/)
  assert.match(shell, /PRIMARY_COOKIE_JAR/)
  assert.match(shell, /SECONDARY_COOKIE_JAR/)
  assert.match(shell, /--cookie "\$cookie_jar"/)
  assert.match(shell, /--cookie-jar "\$cookie_jar"/)
  assert.match(shell, /\/api\/auth\/login/)
  assert.match(shell, /\/api\/auth\/session/)
  assert.match(shell, /\/api\/auth\/logout/)
  assert.doesNotMatch(shell, /NAV_ACCEPTANCE_PASSWORD=/)
  assert.doesNotMatch(shell, /\beval\b/)
  assert.doesNotMatch(shell, /(?:echo|printf)[^\n]*PASSWORD/)
})

test('mail workspace acceptance covers mailbox, rules and cited AI operations', async () => {
  const shell = await source('../../scripts/release/accept-mail-workspace.sh')

  for (const fragment of [
    '/api/email/accounts/$ACCOUNT_ID/messages?folderId=',
    'filter=all&q=$encoded_marker',
    'filter=unread',
    '/api/email/accounts/$ACCOUNT_ID/messages/$LOCATION_ID?folderId=',
    '/api/email/notification-rules/preview',
    '/api/email/notification-rules',
    '/api/email/messages/$MESSAGE_ID/ai',
    '/api/email/ai/search',
    '/api/email/messages/$MESSAGE_ID/ai/proposals',
    '/api/email/messages/$MESSAGE_ID/ai/confirm'
  ]) assert.ok(shell.includes(fragment), fragment)

  assert.match(shell, /action: "summarize"/)
  assert.match(shell, /answer: false/)
  assert.match(shell, /kind: "create_draft"/)
  assert.match(shell, /any\(\.sources\[\]; \.messageId == \$id/)
  assert.match(shell, /previewRequired == true/)
  assert.match(shell, /autoExecuted == false/)
})

test('mail workspace acceptance proves encrypted draft cleanup and a stable outbox', async () => {
  const shell = await source('../../scripts/release/accept-mail-workspace.sh')

  assert.match(shell, /SELECT COUNT\(\*\)::bigint FROM mail_outbox WHERE user_id/)
  assert.match(shell, /OUTBOX_BEFORE="\$\(outbox_count/)
  assert.match(shell, /OUTBOX_AFTER="\$\(outbox_count/)
  assert.match(shell, /"\$OUTBOX_AFTER" == "\$OUTBOX_BEFORE"/)
  assert.match(shell, /payload_encrypted IS NOT NULL/)
  assert.match(shell, /content_hash ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(shell, /DELETE FROM email_drafts WHERE id = '\$draft_id'::uuid/)
  assert.match(shell, /user_id = '\$EPHEMERAL_USER_ID'::uuid/)
  assert.match(shell, /status = 'draft' AND outbox_id IS NULL/)
  assert.match(shell, /real_mail_send=NOT_INVOKED/)
  assert.match(shell, /remote_mailbox_mutation=NOT_INVOKED/)
  assert.doesNotMatch(shell, /\/api\/email\/drafts\/[^'"\n]*\/send/)
  assert.doesNotMatch(shell, /\/api\/admin\/mail\/test/)
})

test('missing synthetic fixture is a non-PASS skip gate', async () => {
  const [shell, docs] = await Promise.all([
    source('../../scripts/release/accept-mail-workspace.sh'),
    source('../../docs/NAV_MAIL_WORKSPACE_ACCEPTANCE.md')
  ])

  assert.match(shell, /readonly EX_SKIP=77/)
  assert.match(shell, /NAV_MAIL_ACCEPTANCE_FIXTURE_MODE/)
  assert.match(shell, /status=SKIP/)
  assert.match(shell, /exit "\$EX_SKIP"/)
  assert.match(docs, /一次性管理员/)
  assert.match(docs, /合成邮件是硬前置/)
  assert.match(docs, /返回 `77`/)
  assert.match(docs, /不会发送真实邮件/)
  assert.match(docs, /不会在 IMAP 服务端/)
})
