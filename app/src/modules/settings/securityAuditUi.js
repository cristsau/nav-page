const EVENT_TYPE_LABELS = Object.freeze({
  'auth.login': '账号登录',
  'auth.logout': '退出登录',
  'auth.recovery': '账号恢复',
  'auth.recovery_codes.rotate': '轮换恢复码',
  'auth.session.revoke': '撤销登录会话',
  'admin.registration.approve': '批准注册',
  'admin.registration.reject': '拒绝注册',
  'admin.telegram_config.update': '更新 Telegram 配置'
})

const OUTCOME_LABELS = Object.freeze({
  success: '成功',
  failure: '失败',
  denied: '已拒绝'
})

const RESOURCE_TYPE_LABELS = Object.freeze({
  session: '登录会话',
  user: '用户',
  registration: '注册申请',
  registration_request: '注册申请',
  recovery_code: '恢复码',
  telegram_config: 'Telegram 配置'
})

function fallbackLabel(value, fallback) {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

export function securityEventTypeLabel(value) {
  return EVENT_TYPE_LABELS[value] || fallbackLabel(value, '未知事件')
}

export function securityOutcomeLabel(value) {
  return OUTCOME_LABELS[value] || fallbackLabel(value, '未知结果')
}

export function securityResourceTypeLabel(value) {
  return RESOURCE_TYPE_LABELS[value] || fallbackLabel(value, '对象')
}

export function compactSecurityIdentifier(value) {
  const normalized = String(value || '').trim()
  if (normalized.length <= 18) return normalized
  return `${normalized.slice(0, 8)}…${normalized.slice(-5)}`
}

export function displaySecurityFingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{16}$/.test(normalized) ? normalized : ''
}
