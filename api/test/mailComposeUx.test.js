import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('mail AI assistant opens as a viewport modal and reveals its result without manual scrolling', async () => {
  const detail = await source('app/src/modules/mail/components/MailMessageDetail.vue')

  assert.match(detail, /import Modal from '@\/shared\/components\/Modal\.vue'/)
  assert.match(detail, /aria-haspopup="dialog"/)
  assert.match(detail, /@click="aiPanelOpen = true"/)
  assert.match(detail, /<Modal[\s\S]*?:show="aiPanelOpen"[\s\S]*?initial-focus-selector="#mail-ai-instruction"/)
  assert.match(detail, /@close="aiPanelOpen = false"/)
  assert.match(detail, /ref="aiResultRef"[\s\S]*?tabindex="-1"/)
  assert.match(detail, /aiResultRef\.value\?\.scrollIntoView\?\.\(/)
  assert.match(detail, /prefers-reduced-motion: reduce/)
  assert.match(detail, /aiResultRef\.value\?\.focus\?\.\(\{ preventScroll: true \}\)/)
})

test('mail list keeps a visible compose entry wired to the existing safe compose dialog', async () => {
  const [view, list, compose] = await Promise.all([
    source('app/src/modules/mail/MailView.vue'),
    source('app/src/modules/mail/components/MailMessageList.vue'),
    source('app/src/modules/mail/components/MailComposeDialog.vue')
  ])

  assert.match(list, /defineEmits\(\[[^\]]*'compose'/)
  assert.match(list, /aria-label="新建邮件"/)
  assert.match(list, /<span>新建邮件<\/span>/)
  assert.match(list, /emit\('compose'\)/)
  assert.match(view, /@compose="openCompose\(\)"/)
  assert.match(view, /<MailComposeDialog/)
  assert.match(view, /:account-id="state\.activeAccountId"/)
  assert.match(compose, /createEmailDraft/)
  assert.match(compose, /confirmEmailDraft/)
  assert.match(compose, /保存并预览/)
  assert.match(compose, /确认发送/)
})
