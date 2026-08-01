import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  compactSecurityIdentifier,
  displaySecurityFingerprint,
  securityEventTypeLabel,
  securityOutcomeLabel,
  securityResourceTypeLabel
} from '../../app/src/modules/settings/securityAuditUi.js'

const sourceFile = (path) => fs.readFile(
  fileURLToPath(new URL(`../../app/src/${path}`, import.meta.url)),
  'utf8'
)

test('security audit labels and identifiers remain explicit and compact', () => {
  assert.equal(securityEventTypeLabel('auth.login'), '账号登录')
  assert.equal(securityOutcomeLabel('denied'), '已拒绝')
  assert.equal(securityResourceTypeLabel('session'), '登录会话')
  assert.equal(securityResourceTypeLabel(''), '对象')
  assert.equal(
    compactSecurityIdentifier('8a6db381-01a5-4731-ae8d-b5c3b49c2be1'),
    '8a6db381…c2be1'
  )
  assert.equal(displaySecurityFingerprint('0123456789abcdef'), '0123456789abcdef')
  assert.equal(displaySecurityFingerprint(' 0123456789abcdef '), '0123456789abcdef')
  assert.equal(displaySecurityFingerprint('198.51.100.27'), '')
  assert.equal(displaySecurityFingerprint('Security Controls Test Browser'), '')
})

test('security audit service isolates the admin query contract', async () => {
  const source = await sourceFile('shared/services/adminSecurityEventsApi.js')

  assert.match(source, /\/admin\/security-events\?\$\{search\.toString\(\)\}/)
  assert.match(source, /search\.set\('eventType', normalizedEventType\)/)
  assert.match(source, /search\.set\('outcome', normalizedOutcome\)/)
  assert.match(source, /pageSize: String\(positiveInteger\(pageSize, DEFAULT_PAGE_SIZE\)\)/)
  assert.match(source, /cache: 'no-store'/)
})

test('settings exposes a responsive admin-only security audit surface', async () => {
  const [settings, component] = await Promise.all([
    sourceFile('modules/settings/Settings.vue'),
    sourceFile('modules/settings/components/SecurityAuditSettings.vue')
  ])

  assert.match(settings, /v-if="backendAuthEnabled && currentUser\?\.role === 'admin'"/)
  assert.match(settings, /id="settings-security-audit"/)
  assert.match(component, /v-if="backendAuthEnabled && isAdmin"/)
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
  assert.match(component, /name="copy"/)
  assert.match(component, /@media \(max-width: 640px\)/)
  assert.match(component, /\.fingerprint,[\s\S]*\.event-id,[\s\S]*\.section-heading > \.button,[\s\S]*\.pagination \.button[\s\S]*min-height: 44px/)
  assert.doesNotMatch(component, /ipAddress|remoteAddress|\.userAgent\b/)
  assert.doesNotMatch(component, /[😀-🙏🌀-🫿]/u)
})
