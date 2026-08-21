const EVENT_TYPE_LABELS = Object.freeze({
  'auth.login': '账号登录',
  'auth.logout': '退出登录',
  'auth.recovery': '账号恢复',
  'auth.recovery_codes.rotate': '轮换恢复码',
  'auth.session.revoke': '撤销登录会话',
  'auth.account.username.update': '修改用户名',
  'auth.account.password.update': '修改密码',
  'admin.registration.approve': '批准注册',
  'admin.registration.reject': '拒绝注册',
  'admin.telegram_config.update': '更新 Telegram 配置',
  'admin.security_events.export': '导出安全审计记录',
  'admin.security_events.delete': '删除安全审计记录'
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
  security_event: '安全审计记录',
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

export function securityRetentionSummary(policy = {}) {
  const routineDays = Number(policy.routineDays || 0)
  const deniedDays = Number(policy.deniedDays || 0)
  const criticalDays = Number(policy.criticalDays || 0)
  if (
    ![routineDays, deniedDays, criticalDays]
      .every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return '服务器未返回有效的审计保留策略。'
  }

  const windows = `常规成功 ${routineDays} 天、失败或拒绝登录 ${deniedDays} 天、敏感操作 ${criticalDays} 天`
  return policy.enabled
    ? `自动保留已启用：${windows}。`
    : `自动保留尚未启用；当前策略预案为${windows}。`
}
