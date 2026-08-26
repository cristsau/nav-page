import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('email client implements accounts, folders, keyset messages, details and credentialed SSE', async () => {
  const api = await source('app/src/shared/services/emailApi.js')
  assert.match(api, /\/email\/accounts'/)
  assert.match(api, /\/email\/accounts\/\$\{requiredId\(accountId[\s\S]*?\/folders/)
  assert.match(api, /query\.set\('cursor'/)
  assert.match(api, /\/messages\/\$\{requiredId\(locationId/)
  assert.match(api, /apiRawRequest\(`\/email\/stream/)
  assert.match(api, /'Last-Event-ID'/)
  assert.match(api, /Accept: 'text\/event-stream'/)
})

test('mail store consumes an indefinite ReadableStream and falls back to visible polling', async () => {
  const store = await source('app/src/modules/mail/useMailStore.js')
  const sse = await source('app/src/modules/mail/mailSse.js')
  assert.match(store, /consumeMailSseBody/)
  assert.match(store, /FALLBACK_POLL_MS = 60_000/)
  assert.match(store, /document\.visibilityState === 'visible'/)
  assert.match(store, /state\.streamState = 'polling'/)
  assert.match(store, /payload\?\.reset === true/)
  assert.match(store, /scheduleMailboxRefresh\(\{ replace: true \}\)/)
  assert.match(store, /createRequestGenerationGate/)
  assert.match(store, /pageRefreshRequests/)
  assert.match(store, /requestStillCurrent/)
  assert.match(store, /watch\([\s\S]*?currentAuthUserId\(\)/)
  assert.match(store, /resetMailStore\(\{ ownerUserId: userId \}\)/)
  assert.match(sse, /body\.getReader\(\)/)
  assert.doesNotMatch(sse, /Missing stream completion event/)
})

test('mail workspace is a desktop three-pane and mobile single-pane read-only UI', async () => {
  const view = await source('app/src/modules/mail/MailView.vue')
  const list = await source('app/src/modules/mail/components/MailMessageList.vue')
  const detail = await source('app/src/modules/mail/components/MailMessageDetail.vue')
  assert.match(view, /grid-template-columns: minmax\(190px, 220px\) minmax\(300px, 360px\) minmax\(0, 1fr\)/)
  assert.match(view, /mail-workspace\.is-detail-open \.mail-workspace__list \{ display: none; \}/)
  assert.match(view, /route\.query\.email/)
  assert.match(view, /mail\.loadLegacyEvent/)
  assert.match(view, /hasLegacyDetail/)
  assert.match(view, /is-legacy-only/)
  assert.match(view, /onBeforeUnmount\(mail\.deactivate\)/)
  assert.match(list, /min-height: 44px/)
  assert.match(list, /aria-current/)
  assert.match(detail, /aria-labelledby="message \? 'mail-message-detail-title'/)
  assert.doesNotMatch(detail, /aria-live="polite"/)
  assert.doesNotMatch(view, /删除邮件|deleteEmail|moveEmail|sendEmail/)
})

test('mobile folder dialog traps focus, closes with Escape and restores focus', async () => {
  const sheet = await source('app/src/modules/mail/components/MailFolderSheet.vue')
  assert.match(sheet, /role="dialog"/)
  assert.match(sheet, /aria-modal="true"/)
  assert.match(sheet, /event\.key === 'Escape'/)
  assert.match(sheet, /event\.key !== 'Tab'/)
  assert.match(sheet, /restoreTarget\?\.focus/)
  assert.match(sheet, /width: 44px; height: 44px/)
})
