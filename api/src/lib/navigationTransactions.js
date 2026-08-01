import { withTransaction } from '../db/index.js'

const RETRYABLE_NAVIGATION_TRANSACTION_CODES = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014'
])

export function isRetryableNavigationTransactionError(error) {
  return RETRYABLE_NAVIGATION_TRANSACTION_CODES.has(String(error?.code || '').toUpperCase())
}

export function createNavigationBusyError(cause) {
  const error = new Error('Navigation is busy; retry the request')
  error.code = 'navigation_busy'
  error.statusCode = 409
  error.headers = { 'retry-after': '1' }
  error.cause = cause
  return error
}

export async function acquireNavigationTransactionLock(client, userId) {
  await client.query("SET LOCAL lock_timeout = '5s'")
  await client.query(
    `
      SELECT pg_advisory_xact_lock(
        hashtext('domonav-navigation-v1'),
        hashtext($1::text)
      )
    `,
    [userId]
  )
}

export async function withNavigationTransaction(userId, callback) {
  try {
    return await withTransaction(async (client) => {
      await acquireNavigationTransactionLock(client, userId)
      return callback(client)
    })
  } catch (error) {
    if (isRetryableNavigationTransactionError(error)) {
      throw createNavigationBusyError(error)
    }
    throw error
  }
}
