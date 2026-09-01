import test from 'node:test'
import assert from 'node:assert/strict'
import { applySavedMailRuntime, safeConnectionError } from '../src/routes/integrations.js'
import { MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING } from '../src/lib/emailRuntimeController.js'
import { MANAGED_MAIL_MATERIALIZATION_WARNING } from '../src/lib/managedMailAccountMaterialization.js'

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

test('mail save response stays truthful when database materialization must retry', async () => {
  const warnings = []
  const error = new Error('private database endpoint failed')
  error.code = MANAGED_MAIL_ACCOUNT_MATERIALIZATION_PENDING
  error.materialization = { attempted: 2, materialized: 1, pending: 1 }
  const result = await applySavedMailRuntime({
    log: { warn(payload, message) { warnings.push({ payload, message }) } }
  }, {
    refreshFn: async () => { throw error }
  })
  assert.deepEqual(result, {
    saved: true,
    materialized: false,
    applied: false,
    warning: MANAGED_MAIL_MATERIALIZATION_WARNING
  })
  assert.equal(JSON.stringify(result).includes('private database endpoint'), false)
  assert.equal(warnings.length, 1)
})

test('mail save response reports convergence only after preflight and runtime start succeed', async () => {
  const result = await applySavedMailRuntime({ log: { warn() {} } }, {
    refreshFn: async () => ({
      reconciliation: { attempted: 2, materialized: 2, pending: 0 }
    })
  })
  assert.deepEqual(result, {
    saved: true,
    materialized: true,
    applied: true
  })
})
