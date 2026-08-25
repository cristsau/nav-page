import test from 'node:test'
import assert from 'node:assert/strict'
import { safeConnectionError } from '../src/routes/integrations.js'

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
