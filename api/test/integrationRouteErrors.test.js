import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED,
  runManagedMailSaveTransaction,
  safeConnectionError
} from '../src/routes/integrations.js'

function transactionHarness({
  preflightError = null,
  applyError = null,
  startError = null,
  restoreError = null,
  restoredStartError = null,
  stopError = null,
  completeUpdateError = null
} = {}) {
  const calls = []
  const warnings = []
  const errors = []
  const state = {
    persistence: 'old-persistence',
    database: 'old-database',
    runtime: 'old-runtime',
    cacheGeneration: 0,
    stopped: false
  }
  let refreshCalls = 0
  return {
    calls,
    warnings,
    errors,
    state,
    request: {
      log: {
        warn(payload, message) { warnings.push({ payload, message }) },
        error(payload, message) { errors.push({ payload, message }) }
      }
    },
    dependencies: {
      runtimeConfig: state,
      assertRuntimeAvailableFn: () => { calls.push('assert-runtime-available') },
      beginUpdateFn: async () => {
        calls.push('begin-update')
        return { token: 'a'.repeat(32) }
      },
      completeUpdateFn: async () => {
        calls.push('complete-update')
        if (completeUpdateError) throw completeUpdateError
      },
      saveFn: async () => {
        calls.push('save')
        state.persistence = 'new-persistence'
        return { id: 'saved-value' }
      },
      snapshotPersistenceFn: async () => {
        calls.push('snapshot-persistence')
        return { persistence: state.persistence }
      },
      restorePersistenceFn: async (snapshot) => {
        calls.push('restore-persistence')
        if (restoreError) throw restoreError
        state.persistence = snapshot.persistence
      },
      loadRuntimeConfigsFn: async () => {
        calls.push('load-runtimes')
        return [{ emailManagedAccount: true }]
      },
      snapshotAccountRowsFn: async () => {
        calls.push('snapshot-account-rows')
        return { database: state.database }
      },
      restoreAccountRowsFn: async (snapshot) => {
        calls.push('restore-account-rows')
        state.database = snapshot.database
      },
      snapshotRuntimeFn: () => {
        calls.push('snapshot-runtime')
        return { runtime: state.runtime }
      },
      restoreRuntimeFn: (snapshot) => {
        calls.push('restore-runtime')
        state.runtime = snapshot.runtime
      },
      clearCacheFn: async () => {
        calls.push('clear-cache')
        state.cacheGeneration += 1
      },
      preflightFn: async () => {
        calls.push('preflight')
        state.database = 'new-database'
        if (preflightError) throw preflightError
      },
      applyRuntimeFn: async () => {
        calls.push('apply-runtime')
        state.runtime = 'new-runtime'
        if (applyError) throw applyError
      },
      refreshFn: async () => {
        refreshCalls += 1
        calls.push(`refresh-${refreshCalls}`)
        if (refreshCalls === 1 && startError) throw startError
        if (
          (preflightError || applyError || startError)
          && refreshCalls > (startError ? 1 : 0)
          && restoredStartError
        ) {
          throw restoredStartError
        }
      },
      suspendRuntimeFn: async () => {
        calls.push('suspend-runtime')
        if (stopError) {
          state.stopped = 'unknown'
          throw stopError
        }
        state.stopped = true
        return { suspended: true }
      }
    }
  }
}

test('cloud activation validation remains actionable without exposing arbitrary errors', () => {
  const activationMessage = '启用云备份前，请完整填写对象存储配置并通过只读连接测试'
  assert.equal(
    safeConnectionError(new TypeError(activationMessage), '云备份配置保存失败'),
    activationMessage
  )
  assert.equal(
    safeConnectionError(new Error('EACCES /etc/nav/integrations/private-secret'), '云备份配置保存失败'),
    '云备份配置保存失败'
  )
})

test('managed mail transaction applies only after preflight and returns the saved value', async () => {
  const harness = transactionHarness()
  const result = await runManagedMailSaveTransaction(harness.request, harness.dependencies)
  assert.deepEqual(result, { id: 'saved-value' })
  assert.equal(harness.state.persistence, 'new-persistence')
  assert.equal(harness.state.runtime, 'new-runtime')
  assert.deepEqual(harness.calls, [
    'assert-runtime-available',
    'begin-update',
    'snapshot-persistence',
    'snapshot-runtime',
    'save',
    'load-runtimes',
    'snapshot-account-rows',
    'clear-cache',
    'preflight',
    'apply-runtime',
    'refresh-1',
    'complete-update'
  ])
})

test('materialization preflight failure restores document, secrets, config and old runtime', async () => {
  const failure = Object.assign(new Error('private database endpoint failed'), {
    code: 'MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING'
  })
  const harness = transactionHarness({ preflightError: failure })
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => error === failure
  )
  assert.equal(harness.state.persistence, 'old-persistence')
  assert.equal(harness.state.database, 'old-database')
  assert.equal(harness.state.runtime, 'old-runtime')
  assert.equal(harness.state.stopped, false)
  assert.equal(harness.calls.includes('apply-runtime'), false)
  assert.equal(harness.calls.filter((call) => call.startsWith('refresh-')).length, 1)
  assert.equal(harness.calls.includes('complete-update'), true)
  assert.equal(harness.warnings.length, 1)
  assert.equal(JSON.stringify(harness.warnings).includes('private database endpoint'), false)
})

test('runtime start failure rolls back new global config and restarts the old runtime', async () => {
  const failure = Object.assign(new Error('new runtime did not start'), {
    code: 'EMAIL_RUNTIME_START_FAILED'
  })
  const harness = transactionHarness({ startError: failure })
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => error === failure
  )
  assert.equal(harness.state.persistence, 'old-persistence')
  assert.equal(harness.state.database, 'old-database')
  assert.equal(harness.state.runtime, 'old-runtime')
  assert.equal(harness.state.stopped, false)
  assert.deepEqual(
    harness.calls.filter((call) => call.startsWith('refresh-')),
    ['refresh-1', 'refresh-2']
  )
})

test('global runtime apply failure restores the previous runtime configuration', async () => {
  const failure = Object.assign(new Error('runtime config apply failed'), {
    code: 'MAIL_RUNTIME_APPLY_FAILED'
  })
  const harness = transactionHarness({ applyError: failure })
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => error === failure
  )
  assert.equal(harness.state.persistence, 'old-persistence')
  assert.equal(harness.state.database, 'old-database')
  assert.equal(harness.state.runtime, 'old-runtime')
  assert.deepEqual(
    harness.calls.filter((call) => call.startsWith('refresh-')),
    ['refresh-1']
  )
})

test('rollback failure is fail-closed and never exposes underlying secrets', async () => {
  const leakedSecret = 'smtp-super-secret'
  const preflightFailure = Object.assign(new Error(`database failed ${leakedSecret}`), {
    code: '57P01'
  })
  const restoreFailure = new Error(`restore failed ${leakedSecret}`)
  const harness = transactionHarness({
    preflightError: preflightFailure,
    restoreError: restoreFailure
  })
  let captured
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => {
      captured = error
      assert.equal(error.code, MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED)
      assert.equal(error.originalErrorCode, '57P01')
      assert.equal(error.rollbackErrorCode, 'MAIL_INTEGRATION_ROLLBACK_FAILED')
      assert.equal(error.suspensionConfirmed, true)
      assert.equal(error.suspensionErrorCode, null)
      assert.equal(error.message.includes(leakedSecret), false)
      return true
    }
  )
  assert.equal(harness.state.stopped, true)
  assert.equal(harness.calls.includes('suspend-runtime'), true)
  assert.equal(harness.calls.some((call) => call.startsWith('refresh-')), false)
  assert.equal(JSON.stringify(harness.errors).includes(leakedSecret), false)
  assert.equal(
    safeConnectionError(captured, 'fallback').includes(leakedSecret),
    false
  )
})

test('old runtime restart failure also enters fail-closed handling', async () => {
  const harness = transactionHarness({
    startError: Object.assign(new Error('new runtime failed'), { code: 'NEW_RUNTIME_FAILED' }),
    restoredStartError: Object.assign(new Error('old runtime failed'), { code: 'OLD_RUNTIME_FAILED' })
  })
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => {
      assert.equal(error.code, MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED)
      assert.equal(error.rollbackErrorCode, 'OLD_RUNTIME_FAILED')
      return true
    }
  )
  assert.equal(harness.state.stopped, true)
})

test('failed runtime suspension reports unknown state without claiming fail-closed success', async () => {
  const leakedSecret = 'worker-stop-private-value'
  const harness = transactionHarness({
    preflightError: Object.assign(new Error('preflight failed'), { code: '57P01' }),
    restoreError: Object.assign(new Error('restore failed'), { code: 'EIO' }),
    stopError: new Error(`stop failed ${leakedSecret}`)
  })
  let captured
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => {
      captured = error
      assert.equal(error.code, MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED)
      assert.equal(error.suspensionConfirmed, false)
      assert.equal(error.suspensionErrorCode, 'MAIL_RUNTIME_SUSPEND_FAILED')
      assert.match(error.message, /运行状态未知/)
      assert.doesNotMatch(error.message, /已暂停/)
      return true
    }
  )
  assert.equal(harness.state.stopped, 'unknown')
  assert.equal(JSON.stringify(harness.errors).includes(leakedSecret), false)
  assert.equal(safeConnectionError(captured, 'fallback').includes(leakedSecret), false)
})

test('an update marker that cannot be removed rolls back and suspends the runtime', async () => {
  const harness = transactionHarness({
    completeUpdateError: Object.assign(new Error('marker unlink failed'), { code: 'EACCES' })
  })
  await assert.rejects(
    runManagedMailSaveTransaction(harness.request, harness.dependencies),
    (error) => {
      assert.equal(error.code, MANAGED_MAIL_TRANSACTION_ROLLBACK_FAILED)
      assert.equal(error.originalErrorCode, 'EACCES')
      assert.equal(error.rollbackErrorCode, 'EACCES')
      assert.equal(error.suspensionConfirmed, true)
      return true
    }
  )
  assert.equal(harness.state.persistence, 'old-persistence')
  assert.equal(harness.state.database, 'old-database')
  assert.equal(harness.state.runtime, 'old-runtime')
  assert.equal(harness.state.stopped, true)
  assert.equal(
    harness.calls.filter((call) => call === 'complete-update').length,
    2
  )
})
