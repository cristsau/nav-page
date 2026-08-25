import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  compactSecurityIdentifier,
  displaySecurityFingerprint,
  securityEventTypeLabel,
  securityOutcomeLabel,
  securityResourceTypeLabel,
  securityRetentionSummary
} from '../../app/src/modules/settings/securityAuditUi.js'

const sourceFile = (path) => fs.readFile(
  fileURLToPath(new URL(`../../app/src/${path}`, import.meta.url)),
  'utf8'
)

test('security audit labels and identifiers remain explicit and compact', () => {
  assert.equal(securityEventTypeLabel('auth.login'), '账号登录')
  assert.equal(securityEventTypeLabel('auth.account.username.update'), '修改用户名')
  assert.equal(securityEventTypeLabel('auth.account.password.update'), '修改密码')
  assert.equal(securityEventTypeLabel('admin.security_events.export'), '导出安全审计记录')
  assert.equal(securityEventTypeLabel('admin.security_events.delete'), '删除安全审计记录')
  assert.equal(securityEventTypeLabel('admin.mail.test'), '发送邮件通道测试')
  assert.equal(securityOutcomeLabel('denied'), '已拒绝')
  assert.equal(securityResourceTypeLabel('session'), '登录会话')
  assert.equal(securityResourceTypeLabel('mail_outbox'), '邮件发送队列')
  assert.equal(securityResourceTypeLabel(''), '对象')
  assert.equal(
    compactSecurityIdentifier('8a6db381-01a5-4731-ae8d-b5c3b49c2be1'),
    '8a6db381…c2be1'
  )
  assert.equal(displaySecurityFingerprint('0123456789abcdef'), '0123456789abcdef')
  assert.equal(displaySecurityFingerprint(' 0123456789abcdef '), '0123456789abcdef')
  assert.equal(displaySecurityFingerprint('198.51.100.27'), '')
  assert.equal(displaySecurityFingerprint('Security Controls Test Browser'), '')
  assert.equal(
    securityRetentionSummary({
      enabled: true,
      routineDays: 90,
      deniedDays: 180,
      criticalDays: 365
    }),
    '自动保留已启用：常规成功 90 天、失败或拒绝登录 180 天、敏感操作 365 天。'
  )
  assert.equal(securityRetentionSummary({}), '服务器未返回有效的审计保留策略。')
})

test('security audit service isolates the admin query contract', async () => {
  const source = await sourceFile('shared/services/adminSecurityEventsApi.js')

  assert.match(source, /\/admin\/security-events\?\$\{search\.toString\(\)\}/)
  assert.match(source, /search\.set\('eventType', normalizedEventType\)/)
  assert.match(source, /search\.set\('outcome', normalizedOutcome\)/)
  assert.match(source, /pageSize: String\(positiveInteger\(pageSize, DEFAULT_PAGE_SIZE\)\)/)
  assert.match(source, /cache: 'no-store'/)
  assert.match(source, /\/admin\/security-events\/delete/)
  assert.match(source, /exportAdminSecurityEvents/)
  assert.match(source, /\/admin\/security-events\/export/)
  assert.match(source, /body: JSON\.stringify\(\{ eventIds, currentPassword \}\)/)
})

test('settings exposes a responsive admin-only security audit surface', async () => {
  const [category, component] = await Promise.all([
    sourceFile('modules/settings/categories/SecurityAuditCategory.vue'),
    sourceFile('modules/settings/components/SecurityAuditSettings.vue')
  ])

  assert.match(category, /v-if="backendAuthEnabled && currentUser\?\.role === 'admin'"/)
  assert.match(category, /id="settings-security-audit"/)
  assert.match(component, /v-if="backendAuthEnabled && isAdmin"/)
  assert.match(component, /const expanded = ref\(false\)/)
  assert.doesNotMatch(component, /onMounted\(\(\) => loadEvents\(1\)\)/)
  assert.match(component, /:aria-expanded="expanded"/)
  assert.match(component, /v-if="expanded" id="security-audit-content"/)
  assert.match(component, /if \(expanded\.value && !loaded\.value/)
  assert.match(component, /事件类型/)
  assert.match(component, /处理结果/)
  assert.match(component, /上一页/)
  assert.match(component, /下一页/)
  assert.match(component, /截断的带密钥关联指纹，不展示原始值/)
  assert.match(component, /客户端关联指纹/)
  assert.match(component, /浏览器关联指纹/)
  assert.match(component, /copyIdentifier\(displaySecurityFingerprint\(event\.clientFingerprint\)/)
  assert.match(component, /copyIdentifier\(displaySecurityFingerprint\(event\.userAgentFingerprint\)/)
  assert.match(component, /displaySecurityFingerprint\(event\.clientFingerprint\)/)
  assert.match(component, /displaySecurityFingerprint\(event\.userAgentFingerprint\)/)
  assert.match(component, /操作用户 ID/)
  assert.match(component, /目标用户 ID/)
  assert.match(component, /securityResourceTypeLabel\(event\.resourceType\)[\s\S]{0,80} ID/)
  assert.match(component, /审计事件 ID/)
  assert.match(component, /选择删除/)
  assert.match(component, /全选本页/)
  assert.match(component, /deleteAdminSecurityEvents/)
  assert.match(component, /autocomplete="current-password"/)
  assert.match(component, /window\.confirm\([\s\S]*永久删除所选/)
  assert.match(component, /删除后会新建一条操作审计/)
  assert.match(component, /每次最多删除 100 条/)
  assert.match(component, /在线审计保留策略/)
  assert.match(component, /job\.name === 'media_delete_retry' && job\.lastStartedAt/)
  assert.match(component, /总积压/)
  assert.match(component, /重试耗尽/)
  assert.match(component, /导出 CSV/)
  assert.match(component, /导出 JSON/)
  assert.match(component, /name="copy"/)
  assert.match(component, /@media \(max-width: 640px\)/)
  assert.match(component, /\.fingerprint,[\s\S]*\.event-id,[\s\S]*\.section-heading > \.button,[\s\S]*\.pagination \.button[\s\S]*min-height: 44px/)
  assert.doesNotMatch(component, /ipAddress|remoteAddress|\.userAgent\b/)
  assert.doesNotMatch(component, /[😀-🙏🌀-🫿]/u)
})
