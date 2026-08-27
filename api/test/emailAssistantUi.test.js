import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('registration UX supports email verification and privacy-preserving resend', async () => {
  const [view, api] = await Promise.all([
    source('../../app/src/modules/auth/AuthView.vue'),
    source('../../app/src/shared/services/authApi.js')
  ])
  assert.match(view, /用于验证并接收审批结果/)
  assert.match(view, /重发验证邮件/)
  assert.match(view, /页面不会透露该邮箱是否存在/)
  assert.match(api, /\/auth\/register\/resend-verification/)
})

test('admin mail settings expose status and an authenticated queue test without secrets', async () => {
  const [view, api, route] = await Promise.all([
    source('../../app/src/modules/settings/components/UserManagementSettings.vue'),
    source('../../app/src/shared/services/emailApi.js'),
    source('../src/routes/email.js')
  ])
  assert.match(view, /Cloudflare 继续负责 DNS/)
  assert.match(view, /发送测试邮件/)
  assert.match(api, /\/admin\/mail\/test/)
  assert.match(route, /requireAdmin/)
  assert.match(route, /recordSecurityEventBestEffort/)
  assert.doesNotMatch(view, /NAV_SMTP_PASSWORD|smtpPassword|apiKey/i)
})

test('assistant is a first-class responsive destination with sources, history and usage visibility', async () => {
  const [route, navigation, primaryNav, mobileNav, view] = await Promise.all([
    source('../../app/src/router/index.js'),
    source('../../app/src/shared/navigation/appNavigation.js'),
    source('../../app/src/shared/components/PrimaryNavigation.vue'),
    source('../../app/src/shared/components/MobileTabBar.vue'),
    source('../../app/src/modules/assistant/AssistantView.vue')
  ])
  assert.match(route, /path: '\/assistant'/)
  assert.match(navigation, /id: 'assistant'/)
  assert.match(primaryNav, /PRIMARY_NAV_ITEMS/)
  assert.match(mobileNav, /PRIMARY_NAV_ITEMS/)
  assert.match(view, /AiUsagePanel/)
  assert.match(view, /fetchBackendChatModels/)
  assert.match(view, /reasoningEffort/)
  assert.match(view, /updateAssistantConversationPreferences/)
  assert.match(view, /来源|sourceId/)
  assert.match(view, /历史/)
})

test('mail is a first-class read-only destination with setup, cache, and legacy deep-link states', async () => {
  const [route, navigation, mobileNav, view, store, emailApi] = await Promise.all([
    source('../../app/src/router/index.js'),
    source('../../app/src/shared/navigation/appNavigation.js'),
    source('../../app/src/shared/components/MobileTabBar.vue'),
    source('../../app/src/modules/mail/MailView.vue'),
    source('../../app/src/modules/mail/useMailStore.js'),
    source('../../app/src/shared/services/emailApi.js')
  ])
  assert.match(route, /path: '\/mail'/)
  assert.match(navigation, /id: 'mail'/)
  assert.match(mobileNav, /flex: 1 1 0/)
  assert.match(view, /已同步邮件保持只读/)
  assert.match(view, /还没有启用智能收件/)
  assert.match(view, /邮箱已连接，但 DOMO NAV 还没有收录邮件/)
  assert.match(view, /已同步内容仍可只读查看/)
  assert.match(store, /loadLegacyEvent/)
  assert.match(emailApi, /fetchEmailEvents/)
  assert.match(emailApi, /fetchEmailEvent/)
})

test('mail settings describe provider-neutral SMTP and IMAP constraints', async () => {
  const [settings, userManagement, mailOutbox, ingest] = await Promise.all([
    source('../../app/src/modules/settings/components/SystemIntegrationsSettings.vue'),
    source('../../app/src/modules/settings/components/UserManagementSettings.vue'),
    source('../src/lib/mailOutbox.js'),
    source('../src/lib/emailIngestScheduler.js')
  ])
  assert.match(settings, /邮件服务（SMTP \/ IMAP）/)
  assert.match(settings, /应用专用密码/)
  assert.doesNotMatch(settings, /MXroute/i)
  assert.doesNotMatch(userManagement, /MXroute/i)
  assert.match(mailOutbox, /SMTP must use implicit TLS on port 465/)
  assert.match(ingest, /IMAP must use TLS port 993/)
})

test('active notification design uses in-app, Web Push and email instead of Telegram', async () => {
  const [maintenance, userSettings, notificationCenter] = await Promise.all([
    source('../src/routes/maintenance.js'),
    source('../../app/src/modules/settings/components/UserManagementSettings.vue'),
    source('../../app/src/shared/components/NotificationCenter.vue')
  ])
  assert.match(maintenance, /channels: \['in_app', 'web_push', 'email'\]/)
  assert.doesNotMatch(maintenance, /telegram/i)
  assert.doesNotMatch(userSettings, /telegram/i)
  assert.match(notificationCenter, /通知/)
})
