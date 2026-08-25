export function smtpTestDisabledReason({
  writable,
  busyAction,
  host,
  username,
  fromAddress,
  passwordConfigured,
  hasUnsavedChanges
}) {
  if (!writable) return '服务器集成目录为只读，不能测试 SMTP。'
  if (busyAction) return '请等待当前邮件操作完成。'
  if (!host) return '请填写 SMTP 主机并保存。'
  if (!username) return '请填写 SMTP 登录邮箱并保存。'
  if (!fromAddress) return '请填写发件地址并保存。'
  if (!passwordConfigured) return '请先输入 SMTP 密码并保存。'
  if (hasUnsavedChanges) return 'SMTP 配置有未保存修改，请先保存。'
  return ''
}

export function imapTestDisabledReason({
  writable,
  busyAction,
  ownerUsername,
  host,
  username,
  passwordConfigured,
  hasUnsavedChanges
}) {
  if (!writable) return '服务器集成目录为只读，不能测试 IMAP。'
  if (busyAction) return '请等待当前邮件操作完成。'
  if (!ownerUsername) return '请填写归属 NAV 用户名并保存。'
  if (!host) return '请填写 IMAP 主机并保存。'
  if (!username) return '请填写 IMAP 登录邮箱并保存。'
  if (!passwordConfigured) return '请先配置 IMAP 密码并保存。'
  if (hasUnsavedChanges) return 'IMAP 配置有未保存修改，请先保存。'
  return ''
}
