import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('mail client submits idempotent remote commands with conflict preconditions and undo', async () => {
  const [api, store] = await Promise.all([
    source('app/src/shared/services/emailApi.js'),
    source('app/src/modules/mail/useMailStore.js')
  ])

  assert.match(api, /createEmailMessageCommand/)
  assert.match(api, /idempotencyKey/)
  assert.match(api, /uidValidity/)
  assert.match(api, /modseq/)
  assert.match(api, /\/email\/accounts\/\$\{requiredId\(accountId[\s\S]*?\/commands/)
  assert.match(api, /\/email\/commands\/\$\{requiredId\(commandId[\s\S]*?\/undo/)
  assert.match(store, /COMMAND_POLL_LIMIT = 150/)
  assert.match(store, /TERMINAL_COMMAND_STATUSES/)
  assert.match(store, /messageCommandExpected/)
  assert.match(store, /commandCanUndo/)
  assert.match(store, /executeMailMessageCommand/)
  assert.match(store, /undoMailMessageCommand/)
  assert.doesNotMatch(store, /message\.flags\.seen\s*=/)
  assert.doesNotMatch(store, /message\.flags\.flagged\s*=/)
})

test('mail detail exposes accessible remote actions without unsafe permanent deletion', async () => {
  const [view, detail, dialog] = await Promise.all([
    source('app/src/modules/mail/MailView.vue'),
    source('app/src/modules/mail/components/MailMessageDetail.vue'),
    source('app/src/modules/mail/components/MailMessageActionDialog.vue')
  ])

  for (const action of ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'move', 'trash', 'delete']) {
    assert.match(detail, new RegExp(`['"]${action}['"]`))
  }
  assert.match(detail, /canPermanentlyDelete/)
  assert.match(dialog, /DELETE_PERMANENTLY/)
  assert.match(detail, /commandCanUndo/)
  assert.match(detail, /远端邮件状态已经变化/)
  assert.match(view, /@undo-command="undoMessageCommand"/)
  assert.match(view, /:folders="activeFolders"/)
  assert.match(dialog, /role="dialog"/)
  assert.match(dialog, /aria-modal="true"/)
  assert.match(dialog, /event\.key === 'Escape'/)
  assert.match(dialog, /event\.key !== 'Tab'/)
  assert.match(dialog, /restoreTarget\?\.focus/)
  assert.match(dialog, /输入 DELETE 确认/)
  assert.match(dialog, /width: 44px; height: 44px/)
})
