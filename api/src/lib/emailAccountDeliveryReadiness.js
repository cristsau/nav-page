import { config } from '../config.js'
import { managedMailRuntimeConfigs } from './managedIntegrations.js'
import { verifiedMailConfigurationStatus } from './mailOutbox.js'

const SOURCE_KEY_PATTERN = /^[a-z0-9_.-]{1,80}$/

function normalizedSourceKey(value) {
  const sourceKey = String(value || '').trim().toLowerCase()
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) throw new TypeError('Email account source is invalid')
  return sourceKey
}

function normalizedOwnerUsername(value) {
  const username = String(value || '').normalize('NFKC').trim()
  if (!username || username.length > 128 || /[\u0000-\u001F\u007F]/.test(username)) {
    throw new TypeError('Email account owner is invalid')
  }
  return username
}

function unavailable(reason) {
  return { ready: false, enabled: false, configured: false, reason }
}

function matchingRuntime(runtimes, source, owner, runtimeConfig) {
  return runtimes.find((candidate) => (
    String(candidate?.emailSourceKey || runtimeConfig.emailSourceKey || 'mxroute').trim().toLowerCase() === source
    && String(candidate?.emailOwnerUsername || '').normalize('NFKC').trim() === owner
  )) || null
}

export async function resolveEmailAccountDeliveryReadiness({
  sourceKey,
  ownerUsername,
  runtimeConfigs
}, {
  runtimeConfig = config,
  loadRuntimes = managedMailRuntimeConfigs,
  statusFn = verifiedMailConfigurationStatus
} = {}) {
  const source = normalizedSourceKey(sourceKey)
  const owner = normalizedOwnerUsername(ownerUsername)
  let runtimes
  try {
    runtimes = Array.isArray(runtimeConfigs)
      ? runtimeConfigs
      : await loadRuntimes(runtimeConfig)
  } catch {
    return unavailable('runtime_unavailable')
  }
  const matched = matchingRuntime(runtimes, source, owner, runtimeConfig)
  if (!matched) return unavailable('account_not_configured')
  if (matched.mailDeliveryEnabled !== true) return unavailable('delivery_disabled')
  try {
    const status = await statusFn(matched)
    const configured = status?.configured === true
    const enabled = status?.enabled === true
    return {
      ready: configured && enabled,
      enabled,
      configured,
      reason: configured && enabled ? 'ready' : 'smtp_unavailable'
    }
  } catch {
    return unavailable('smtp_unavailable')
  }
}

export async function resolveEmailAccountRemoteActionReadiness({
  sourceKey,
  ownerUsername,
  runtimeConfigs
}, {
  runtimeConfig = config,
  loadRuntimes = managedMailRuntimeConfigs
} = {}) {
  const source = normalizedSourceKey(sourceKey)
  const owner = normalizedOwnerUsername(ownerUsername)
  let runtimes
  try {
    runtimes = Array.isArray(runtimeConfigs)
      ? runtimeConfigs
      : await loadRuntimes(runtimeConfig)
  } catch {
    return { ready: false, reason: 'runtime_unavailable' }
  }
  const matched = matchingRuntime(runtimes, source, owner, runtimeConfig)
  if (!matched) return { ready: false, reason: 'account_not_configured' }
  return matched.emailIngestEnabled === true
    ? { ready: true, reason: 'ready' }
    : { ready: false, reason: 'ingest_disabled' }
}

export class EmailAccountDeliveryUnavailableError extends Error {
  constructor(reason = 'smtp_unavailable') {
    super('The selected mailbox is not configured and enabled for SMTP delivery')
    this.name = 'EmailAccountDeliveryUnavailableError'
    this.code = 'EMAIL_ACCOUNT_DELIVERY_UNAVAILABLE'
    this.reason = reason
    this.statusCode = 503
  }
}

export class EmailAccountRemoteActionsUnavailableError extends Error {
  constructor(reason = 'ingest_disabled') {
    super('The selected mailbox is not enabled for remote IMAP actions')
    this.name = 'EmailAccountRemoteActionsUnavailableError'
    this.code = 'EMAIL_ACCOUNT_REMOTE_ACTIONS_UNAVAILABLE'
    this.reason = reason
    this.statusCode = 503
  }
}

export async function assertEmailAccountDeliveryReady({
  userId,
  accountId,
  queryFn,
  runtimeConfigs
}, dependencies = {}) {
  if (typeof queryFn !== 'function') throw new TypeError('Email account query is unavailable')
  const { rows } = await queryFn(
    `SELECT account.source_key, owner.username AS owner_username
     FROM email_accounts AS account
     JOIN users AS owner ON owner.id = account.user_id
     WHERE account.id = $1 AND account.user_id = $2 AND account.enabled = TRUE
     LIMIT 1`,
    [accountId, userId]
  )
  if (!rows?.[0]) throw new EmailAccountDeliveryUnavailableError('account_disabled')
  const readiness = await resolveEmailAccountDeliveryReadiness({
    sourceKey: rows[0].source_key,
    ownerUsername: rows[0].owner_username,
    runtimeConfigs
  }, dependencies)
  if (!readiness.ready) throw new EmailAccountDeliveryUnavailableError(readiness.reason)
  return readiness
}

export async function assertEmailAccountRemoteActionsReady({
  userId,
  accountId,
  queryFn,
  runtimeConfigs
}, dependencies = {}) {
  if (typeof queryFn !== 'function') throw new TypeError('Email account query is unavailable')
  const { rows } = await queryFn(
    `SELECT account.source_key, owner.username AS owner_username
     FROM email_accounts AS account
     JOIN users AS owner ON owner.id = account.user_id
     WHERE account.id = $1 AND account.user_id = $2 AND account.enabled = TRUE
     LIMIT 1`,
    [accountId, userId]
  )
  if (!rows?.[0]) throw new EmailAccountRemoteActionsUnavailableError('account_disabled')
  const readiness = await resolveEmailAccountRemoteActionReadiness({
    sourceKey: rows[0].source_key,
    ownerUsername: rows[0].owner_username,
    runtimeConfigs
  }, dependencies)
  if (!readiness.ready) throw new EmailAccountRemoteActionsUnavailableError(readiness.reason)
  return readiness
}
