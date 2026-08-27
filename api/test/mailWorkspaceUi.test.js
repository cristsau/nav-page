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
  assert.match(detail, /aria-live="polite"/)
  assert.doesNotMatch(view, /删除邮件|deleteEmail|moveEmail|sendEmail/)
})

test('mail attachment UI uploads sequentially, reviews metadata and downloads only on demand', async () => {
  const [api, compose, detail, view] = await Promise.all([
    source('app/src/shared/services/emailApi.js'),
    source('app/src/modules/mail/components/MailComposeDialog.vue'),
    source('app/src/modules/mail/components/MailMessageDetail.vue'),
    source('app/src/modules/mail/MailView.vue')
  ])
  assert.match(api, /\/email\/drafts\/\$\{requiredId\(draftId[\s\S]*?\/attachments\?\$\{query\.toString\(\)\}/)
  assert.match(api, /'Content-Type': 'application\/octet-stream'/)
  assert.match(api, /\/messages\/\$\{requiredId\(locationId[\s\S]*?\/attachments\/\$\{requiredId\(attachmentId/)
  assert.match(compose, /MAX_ATTACHMENT_COUNT = 10/)
  assert.match(compose, /MAX_ATTACHMENT_BYTES = 10 \* 1024 \* 1024/)
  assert.match(compose, /MAX_TOTAL_ATTACHMENT_BYTES = 25 \* 1024 \* 1024/)
  assert.match(compose, /for \(const entry of selectedAttachments\.value\)/)
  assert.match(compose, /retryAttachment\(entry\)/)
  assert.match(compose, /deleteEmailDraftAttachment/)
  assert.match(compose, /附件（\{\{ selectedAttachments\.length \}\}）/)
  assert.match(compose, /stage\.value = 'queued'/)
  assert.doesNotMatch(compose, /stage\.value = 'sent'/)
  assert.match(compose, /scheduleQueuedStatusRefresh\(generation, delay = 2_000\)/)
  assert.match(compose, /statusPollInFlight/)
  assert.match(compose, /fetchEmailDraft\(draftId\.value\)/)
  assert.match(compose, /deliveryStatus/)
  assert.match(compose, /deliveryErrorCode/)
  assert.match(compose, /AMBIGUOUS_DELIVERY_STATE/)
  assert.match(compose, /PARTIAL_RECIPIENT_REJECTION/)
  assert.match(compose, /邮件可能已送达[\s\S]*?不要直接重发/)
  assert.match(compose, /部分收件人未接收[\s\S]*?不要直接整体重发/)
  assert.match(compose, /deliveryStatus\.value === 'partial' && !sentSyncStatusTerminal\.value/)
  assert.match(compose, /sentSyncStatus/)
  assert.match(compose, /onBeforeUnmount\(stopQueuedStatusPolling\)/)
  assert.match(compose, /window\.clearTimeout\(statusPollTimer\)/)
  assert.match(detail, /downloadEmailAttachment/)
  assert.match(detail, /URL\.createObjectURL/)
  assert.match(detail, /URL\.revokeObjectURL/)
  assert.match(detail, /页面不会自动预览或执行附件/)
  assert.match(view, /:account-id="state\.activeAccountId"/)
  assert.match(view, /:folder-id="state\.activeFolderId"/)
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

test('mail workspace exposes server search, notification controls and one AI assistant entry', async () => {
  const [api, store, view, list, detail, ruleDialog] = await Promise.all([
    source('app/src/shared/services/emailApi.js'),
    source('app/src/modules/mail/useMailStore.js'),
    source('app/src/modules/mail/MailView.vue'),
    source('app/src/modules/mail/components/MailMessageList.vue'),
    source('app/src/modules/mail/components/MailMessageDetail.vue'),
    source('app/src/modules/mail/components/MailNotificationRuleDialog.vue')
  ])

  assert.match(api, /query\.set\('q'/)
  assert.match(api, /query\.set\('filter'/)
  assert.match(store, /setMailSearch/)
  assert.match(store, /slice\(0, 120\)/)
  assert.match(store, /q: state\.searchQuery/)
  assert.match(store, /filter: state\.searchFilter/)
  assert.match(view, /@query-change="applyMailQuery"/)
  assert.match(list, /全部/)
  assert.match(list, /未读/)
  assert.match(list, /重要/)
  assert.match(list, /附件/)
  assert.match(list, /notificationAction/)
  assert.match(detail, /邮件 AI 助理/)
  assert.match(detail, /thread_summary/)
  assert.match(detail, /thread_changes/)
  assert.match(detail, /analyze/)
  assert.doesNotMatch(detail, /explain_priority|risk_review/)
  assert.match(detail, /sandbox=""/)
  assert.match(detail, /远程图片、脚本、表单和外部资源已阻止/)
  assert.match(ruleDialog, /手动规则始终优先于 AI 分类/)
  assert.match(ruleDialog, /当前会话/)
  assert.match(ruleDialog, /这个发件人/)
  assert.match(ruleDialog, /这个发件人域名/)
  assert.match(ruleDialog, /完全静音/)
  assert.match(ruleDialog, /\^\[a-f0-9\]\{64\}\$/)
  assert.match(ruleDialog, /requiresCriticalConfirmation/)
  assert.match(ruleDialog, /criticalMatchCount/)
  assert.match(ruleDialog, /\['digest', 'in_app_only', 'silent'\]/)
  assert.match(ruleDialog, /event\.key === 'Escape'/)
})

test('mail AI UI follows the bounded server actions, citations and confirm-before-write contract', async () => {
  const [api, view, list, detail, searchDialog] = await Promise.all([
    source('app/src/shared/services/emailApi.js'),
    source('app/src/modules/mail/MailView.vue'),
    source('app/src/modules/mail/components/MailMessageList.vue'),
    source('app/src/modules/mail/components/MailMessageDetail.vue'),
    source('app/src/modules/mail/components/MailAiSearchDialog.vue')
  ])

  for (const action of ['summarize', 'thread_summary', 'thread_changes', 'tasks', 'analyze', 'draft_reply', 'translate', 'ask', 'propose_notification_rule']) {
    assert.match(detail, new RegExp(`['\"]${action}['\"]`))
  }
  assert.doesNotMatch(detail, /explain_priority|risk_review/)
  assert.match(api, /scope: String\(scope/)
  assert.match(api, /tone: String\(tone/)
  assert.match(api, /length: String\(length/)
  assert.match(detail, /value="message"/)
  assert.match(detail, /value="thread"/)
  assert.match(detail, /回信语气/)
  assert.match(detail, /回信长度/)
  assert.match(detail, /aiResult\.structured/)
  assert.match(detail, /依据来源/)
  assert.match(detail, /AI 建议，尚未保存/)
  assert.match(detail, /打开提醒规则，由我确认/)
  assert.match(detail, /Math\.max\(0, Math\.min\(100, Math\.round\(score\)\)\)/)
  assert.match(list, /importanceScore \|\| 0\) >= 72/)

  assert.match(api, /\/email\/messages\/\$\{requiredId\(messageId[\s\S]*?\/ai\/proposals/)
  assert.match(api, /\/email\/messages\/\$\{requiredId\(messageId[\s\S]*?\/ai\/confirm/)
  assert.match(detail, /previewRequired/)
  assert.match(detail, /autoExecuted !== false/)
  assert.match(detail, /尚未写入/)
  assert.match(detail, /确认保存日记/)
  assert.match(detail, /确认保存备忘录/)
  assert.match(detail, /确认创建加密草稿/)

  assert.match(api, /\/email\/ai\/search/)
  assert.match(view, /问整个邮箱/)
  assert.match(view, /MailAiSearchDialog/)
  assert.match(searchDialog, /role="dialog"/)
  assert.match(searchDialog, /aria-modal="true"/)
  assert.match(searchDialog, /event\.key === 'Escape'/)
  assert.match(searchDialog, /event\.key !== 'Tab'/)
  assert.match(searchDialog, /restoreTarget\?\.focus/)
  assert.match(searchDialog, /依据来源/)
})
