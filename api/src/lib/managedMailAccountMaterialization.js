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

function managedRuntimeIdentities(runtimeConfigs) {
  const unique = new Map()
  for (const runtimeConfig of Array.isArray(runtimeConfigs) ? runtimeConfigs : []) {
    if (runtimeConfig?.emailManagedAccount !== true) continue
    const ownerUsername = normalizedOwnerUsername(runtimeConfig.emailOwnerUsername)
    const sourceKey = normalizedSourceKey(runtimeConfig.emailSourceKey)
    unique.set(`${ownerUsername}\u0000${sourceKey}`, { ownerUsername, sourceKey })
  }
  return [...unique.values()]
}

export async function snapshotManagedMailAccountRows(
  runtimeConfigs,
  { queryFn = query } = {}
) {
  const accounts = []
  for (const identity of managedRuntimeIdentities(runtimeConfigs)) {
    const result = await queryFn(
      `SELECT owner.id AS owner_user_id,
              account.id, account.user_id, account.source_key,
              account.label, account.enabled, account.updated_at
       FROM users AS owner
       LEFT JOIN email_accounts AS account
         ON account.user_id = owner.id
        AND account.source_key = $2
       WHERE owner.username = $1
         AND owner.status = 'approved'
       LIMIT 1`,
      [identity.ownerUsername, identity.sourceKey]
    )
    const row = result.rows?.[0]
    if (!row?.owner_user_id) throw new TypeError('邮件归属用户不存在或尚未获批')
    accounts.push({
      ...identity,
      ownerUserId: row.owner_user_id,
      row: row.id
        ? {
            id: row.id,
            userId: row.user_id,
            sourceKey: row.source_key,
            label: row.label,
            enabled: row.enabled === true,
            updatedAt: row.updated_at
          }
        : null
    })
  }
  return { accounts }
}

export async function restoreManagedMailAccountRows(
  snapshot,
  { queryFn = query } = {}
) {
  for (const account of Array.isArray(snapshot?.accounts) ? snapshot.accounts : []) {
    if (account.row) {
      const result = await queryFn(
        `UPDATE email_accounts
         SET label = $4,
             enabled = $5,
             updated_at = $6
         WHERE id = $1
           AND user_id = $2
           AND source_key = $3`,
        [
          account.row.id,
          account.row.userId,
          account.row.sourceKey,
          account.row.label,
          account.row.enabled,
          account.row.updatedAt
        ]
      )
      if (result.rowCount !== 1) {
        throw Object.assign(new Error('Managed mailbox account rollback row is missing'), {
          code: 'MANAGED_MAIL_ACCOUNT_ROLLBACK_ROW_MISSING'
        })
      }
      continue
    }
    await queryFn(
      `DELETE FROM email_accounts
       WHERE user_id = $1
         AND source_key = $2`,
      [account.ownerUserId, account.sourceKey]
    )
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
