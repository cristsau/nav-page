import { query } from '../db/index.js'

export const MANAGED_MAIL_MATERIALIZATION_WARNING = '邮箱配置已保存，但账号数据库登记仍待处理；请稍后重新保存重试。'

function normalizedOwnerUsername(value) {
  const username = String(value || '').normalize('NFKC').trim()
  if (!username || username.length > 128 || /[\u0000-\u001F\u007F]/.test(username)) {
    throw new TypeError('邮件归属用户格式无效')
  }
  return username
}

function normalizedSourceKey(value) {
  const sourceKey = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9_.-]{1,80}$/.test(sourceKey)) throw new TypeError('邮箱账号来源标识无效')
  return sourceKey
}

export async function assertManagedMailOwnerExists(ownerUsername, { queryFn = query } = {}) {
  const owner = normalizedOwnerUsername(ownerUsername)
  const result = await queryFn(
    "SELECT id FROM users WHERE username = $1 AND status = 'approved' LIMIT 1",
    [owner]
  )
  if (!result.rows?.[0]) throw new TypeError('邮件归属用户不存在或尚未获批')
  return result.rows[0].id
}

export async function materializeManagedMailAccount(accountState, { queryFn = query } = {}) {
  const mailConfig = accountState?.config || {}
  const ownerUsername = normalizedOwnerUsername(mailConfig.ownerUsername)
  const sourceKey = normalizedSourceKey(accountState?.sourceKey)
  const label = String(accountState?.label || '个人邮箱').normalize('NFKC').trim().slice(0, 120)
  if (!label) throw new TypeError('邮箱账号名称格式无效')
  const enabled = mailConfig.deliveryEnabled === true || mailConfig.ingestEnabled === true
  const result = await queryFn(
    `INSERT INTO email_accounts (user_id, source_key, label, enabled)
     SELECT owner.id, $1, $2, $3
     FROM users AS owner
     WHERE owner.username = $4 AND owner.status = 'approved'
     ON CONFLICT (user_id, source_key) DO UPDATE SET
       label = EXCLUDED.label,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()
     RETURNING id, user_id, source_key, label, enabled`,
    [sourceKey, label, enabled, ownerUsername]
  )
  if (!result.rows?.[0]) throw new TypeError('邮件归属用户不存在或尚未获批')
  return result.rows[0]
}

function safeErrorCode(error) {
  const code = String(error?.code || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'EMAIL_ACCOUNT_MATERIALIZATION_FAILED'
}

export async function materializeManagedMailAccountBestEffort(
  accountState,
  { materializeFn = materializeManagedMailAccount } = {}
) {
  try {
    await materializeFn(accountState)
    return { saved: true, materialized: true, warning: null, errorCode: null }
  } catch (error) {
    return {
      saved: true,
      materialized: false,
      warning: MANAGED_MAIL_MATERIALIZATION_WARNING,
      errorCode: safeErrorCode(error)
    }
  }
}

function accountStateFromRuntime(runtimeConfig) {
  return {
    sourceKey: runtimeConfig.emailSourceKey,
    label: runtimeConfig.emailAccountLabel,
    config: {
      ownerUsername: runtimeConfig.emailOwnerUsername,
      deliveryEnabled: runtimeConfig.mailDeliveryEnabled === true,
      ingestEnabled: runtimeConfig.emailIngestEnabled === true
    }
  }
}

export async function reconcileManagedMailRuntimeAccounts(
  runtimeConfigs,
  { materializeFn = materializeManagedMailAccount } = {}
) {
  const managedRuntimes = (Array.isArray(runtimeConfigs) ? runtimeConfigs : [])
    .filter((runtimeConfig) => runtimeConfig?.emailManagedAccount === true)
  const results = []
  for (const runtimeConfig of managedRuntimes) {
    const outcome = await materializeManagedMailAccountBestEffort(
      accountStateFromRuntime(runtimeConfig),
      { materializeFn }
    )
    results.push({
      sourceKey: String(runtimeConfig.emailSourceKey || '').trim().toLowerCase(),
      ...outcome
    })
  }
  return {
    attempted: results.length,
    materialized: results.filter((result) => result.materialized).length,
    pending: results.filter((result) => !result.materialized).length,
    results
  }
}
