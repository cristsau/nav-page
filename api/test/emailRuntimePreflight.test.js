import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMAIL_RUNTIME_FAIL_CLOSED,
  EMAIL_RUNTIME_SUSPEND_FAILED,
  MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING,
  preflightEmailRuntime,
  refreshEmailRuntime,
  replaceEmailRuntime,
  stopEmailRuntime,
  suspendEmailRuntime
} from '../src/lib/emailRuntimeController.js'
import { reconcileManagedMailRuntimeAccounts } from '../src/lib/managedMailAccountMaterialization.js'

test('runtime preflight preserves the old workers until materialization succeeds on retry', async () => {
  const runtimeConfig = {
    emailRuntimeRole: 'worker',
    databasePoolMax: 12
  }
  const runtimes = [{
    emailManagedAccount: true,
    emailSourceKey: 'managed.0123456789abcdef01234567',
    emailAccountLabel: '工作邮箱',
    emailOwnerUsername: 'owner-a',
    mailDeliveryEnabled: true,
    emailIngestEnabled: true
  }]
  const storedSources = new Set()
  let databaseAvailable = false
  let stopCalls = 0
  let startCalls = 0
  const reconcileFn = (items) => reconcileManagedMailRuntimeAccounts(items, {
    materializeFn: async (accountState) => {
      if (!databaseAvailable) throw Object.assign(new Error('database restarting'), { code: '57P01' })
      storedSources.add(accountState.sourceKey)
    }
  })
  const replace = () => replaceEmailRuntime({
    preflight: () => preflightEmailRuntime({
      runtimeConfig,
      loadRuntimes: async () => runtimes,
      reconcileFn
    }),
    stop: async () => { stopCalls += 1 },
    start: async () => { startCalls += 1 }
  })

  await assert.rejects(replace(), (error) => {
    assert.equal(error.code, MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING)
    return true
  })
  assert.equal(stopCalls, 0)
  assert.equal(startCalls, 0)
  assert.equal(storedSources.size, 0)

  databaseAvailable = true
  const prepared = await replace()
  assert.equal(prepared.reconciliation.pending, 0)
  assert.equal(stopCalls, 1)
  assert.equal(startCalls, 1)
  assert.deepEqual([...storedSources], ['managed.0123456789abcdef01234567'])
})

test('a fail-closed runtime suspension blocks later refresh until process reconfiguration', async () => {
  let stopCalls = 0
  await suspendEmailRuntime({
    reason: 'TEST_ROLLBACK_FAILED',
    stopFn: async () => { stopCalls += 1 }
  })
  try {
    assert.equal(stopCalls, 1)
    await assert.rejects(refreshEmailRuntime(), (error) => {
      assert.equal(error.code, EMAIL_RUNTIME_FAIL_CLOSED)
      assert.equal(error.suspensionReason, 'TEST_ROLLBACK_FAILED')
      return true
    })
  } finally {
    await stopEmailRuntime()
  }
})

test('a failed worker stop keeps the refresh latch closed and reports suspension as unconfirmed', async () => {
  await assert.rejects(
    suspendEmailRuntime({
      stopFn: async () => {
        throw Object.assign(new Error('private worker stop details'), { code: 'EWORKER' })
      }
    }),
    (error) => {
      assert.equal(error.code, EMAIL_RUNTIME_SUSPEND_FAILED)
      assert.equal(error.stopErrorCode, 'EWORKER')
      assert.equal(error.message.includes('private worker stop details'), false)
      return true
    }
  )
  try {
    await assert.rejects(
      refreshEmailRuntime(),
      (error) => error.code === EMAIL_RUNTIME_FAIL_CLOSED
    )
  } finally {
    await stopEmailRuntime()
  }
})
