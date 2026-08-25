import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAssistantPreferences,
  AssistantPreferenceError,
  normalizeAssistantPreferences
} from '../src/lib/assistantPreferences.js'

const resolution = {
  provider: { model: 'gpt-5.6-terra', apiMode: 'responses' },
  catalog: {
    latestModelId: 'gpt-5.6-sol',
    resolvedModelId: 'gpt-5.6-sol',
    models: [
      { id: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra' }
    ]
  }
}

test('assistant preferences default to latest with low reasoning', () => {
  assert.deepEqual(normalizeAssistantPreferences(), {
    modelMode: 'latest',
    model: null,
    reasoningEffort: 'low'
  })
})

test('assistant provider applies default preferences when legacy query omits them', () => {
  const selected = applyAssistantPreferences(resolution)
  assert.deepEqual(selected.preferences, {
    modelMode: 'latest',
    model: null,
    reasoningEffort: 'low'
  })
  assert.equal(selected.provider.modelMode, 'latest')
  assert.equal(selected.provider.model, 'gpt-5.6-sol')
  assert.equal(selected.provider.reasoningEffort, 'low')
})

test('assistant preferences use stored conversation values as fallback', () => {
  assert.deepEqual(normalizeAssistantPreferences({}, {
    modelMode: 'pinned',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'high'
  }), {
    modelMode: 'pinned',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'high'
  })
})

test('assistant preferences only allow models from the server catalog', () => {
  assert.throws(
    () => applyAssistantPreferences(resolution, {
      modelMode: 'pinned',
      model: 'attacker-controlled-model',
      reasoningEffort: 'low'
    }),
    AssistantPreferenceError
  )
})

test('assistant latest mode resolves on the server and applies reasoning', () => {
  const selected = applyAssistantPreferences(resolution, {
    modelMode: 'latest',
    model: null,
    reasoningEffort: 'xhigh'
  })
  assert.equal(selected.provider.model, 'gpt-5.6-sol')
  assert.equal(selected.provider.reasoningEffort, 'xhigh')
})
