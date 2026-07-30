import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeAppConfigSecrets,
  redactAppConfigSecrets,
  resolveProviderTestConfig
} from '../src/lib/settingsSecrets.js'

function makeConfig(apiKey = '') {
  return {
    site: { name: 'DOMO NAV' },
    search: {
      providers: {
        chatgpt: {
          enabled: true,
          endpoint: 'https://api.example.com/v1/responses',
          apiKey
        },
        brave: {
          enabled: false,
          apiKey: ''
        },
        openclaw: {
          enabled: false,
          apiKey: ''
        }
      }
    }
  }
}

test('app config responses redact provider keys and expose configuration state', () => {
  const redacted = redactAppConfigSecrets(makeConfig('server-secret'))

  assert.equal(redacted.search.providers.chatgpt.apiKey, '')
  assert.equal(redacted.search.providers.chatgpt.apiKeyConfigured, true)
  assert.equal(JSON.stringify(redacted).includes('server-secret'), false)
})

test('blank provider keys preserve stored secrets during settings updates', () => {
  const existing = makeConfig('stored-secret')
  const incoming = makeConfig('')
  incoming.site.name = 'Updated DOMO NAV'
  incoming.search.providers.chatgpt.apiKeyConfigured = true

  const merged = mergeAppConfigSecrets(incoming, existing)

  assert.equal(merged.site.name, 'Updated DOMO NAV')
  assert.equal(merged.search.providers.chatgpt.apiKey, 'stored-secret')
  assert.equal('apiKeyConfigured' in merged.search.providers.chatgpt, false)
})

test('provider secrets are cleared only with an explicit clear flag', () => {
  const incoming = makeConfig('')
  incoming.search.providers.chatgpt.clearApiKey = true

  const merged = mergeAppConfigSecrets(incoming, makeConfig('stored-secret'))

  assert.equal(merged.search.providers.chatgpt.apiKey, '')
  assert.equal('clearApiKey' in merged.search.providers.chatgpt, false)
})

test('provider tests reuse a stored key when the browser submits no key', () => {
  const resolved = resolveProviderTestConfig(
    'chatgpt',
    { enabled: true, apiKey: '', model: 'test-model' },
    makeConfig('stored-secret')
  )

  assert.equal(resolved.apiKey, 'stored-secret')
  assert.equal(resolved.model, 'test-model')
})

test('changing a provider destination never carries the stored key forward', () => {
  const existing = makeConfig('stored-secret')
  const incoming = makeConfig('')
  incoming.search.providers.chatgpt.endpoint = 'https://attacker.invalid/collect'

  const merged = mergeAppConfigSecrets(incoming, existing)
  const testConfig = resolveProviderTestConfig(
    'chatgpt',
    incoming.search.providers.chatgpt,
    existing
  )

  assert.equal(merged.search.providers.chatgpt.apiKey, '')
  assert.equal(testConfig.apiKey, '')
})

test('invalid app config structures are rejected instead of erasing secrets', () => {
  assert.throws(
    () => mergeAppConfigSecrets(null, makeConfig('stored-secret')),
    /must be an object/
  )
  assert.throws(
    () => mergeAppConfigSecrets([], makeConfig('stored-secret')),
    /must be an object/
  )
})
