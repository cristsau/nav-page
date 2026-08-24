import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAppConfigModelIds } from '../src/lib/aiModelSettings.js'
import {
  buildChatRequest,
  normalizeConfiguredChatApiMode,
  normalizeReasoningEffort
} from '../src/lib/aiResponses.js'

function appConfig(provider) {
  return { search: { providers: { chatgpt: provider } } }
}

test('server rejects unsupported API modes and reasoning strengths', () => {
  assert.equal(normalizeConfiguredChatApiMode('responses'), 'responses')
  assert.equal(normalizeReasoningEffort('xhigh'), 'xhigh')
  assert.throws(
    () => validateAppConfigModelIds(appConfig({ apiMode: 'responsez' })),
    /API 格式无效/
  )
  assert.throws(
    () => validateAppConfigModelIds(appConfig({ reasoningEffort: 'extreme' })),
    /推理强度无效/
  )
})

test('runtime request builder also rejects invalid unsaved test configuration', () => {
  assert.throws(() => buildChatRequest({
    enabled: true,
    apiMode: 'chat-completions',
    endpoint: 'https://api.example.com/v1/chat/completions',
    model: 'gpt-test',
    reasoningEffort: 'extreme'
  }, 'hello', 'system'), /推理强度无效/)
})
