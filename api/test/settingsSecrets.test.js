import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeAppConfigSecrets,
  redactAppConfigSecrets,
  resolveProviderTestConfig,
  sanitizeRetiredSearchProviders
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
        }
      }
    }
  }
}

function withRetiredOpenClaw(config = makeConfig('')) {
  config.searchEngine = 'openclaw'
  config.search.quickAccessEngineIds = ['baidu', 'openclaw']
  config.search.hiddenEngineIds = ['openclaw', 'weibo']
  config.search.aggregate = {
    enabled: true,
    engines: ['openclaw', 'bing']
  }
  config.search.providers.openclaw = {
    enabled: true,
    endpoint: 'https://retired.example.test/v1/chat/completions',
    apiKey: 'retired-provider-secret',
    model: 'retired-model'
  }
  return config
}

test('app config responses redact provider keys and expose configuration state', () => {
  const redacted = redactAppConfigSecrets(makeConfig('server-secret'))

  assert.equal(redacted.search.providers.chatgpt.apiKey, '')
  assert.equal(redacted.search.providers.chatgpt.apiKeyConfigured, true)
  assert.equal(JSON.stringify(redacted).includes('server-secret'), false)
})

test('retired provider config and secrets are removed before settings reach the browser', () => {
  const stale = withRetiredOpenClaw()
  const sanitized = sanitizeRetiredSearchProviders(stale)
  const redacted = redactAppConfigSecrets(stale)
  const merged = mergeAppConfigSecrets(stale, stale)

  for (const config of [sanitized, redacted, merged]) {
    assert.equal(config.searchEngine, 'baidu')
    assert.deepEqual(config.search.quickAccessEngineIds, ['baidu'])
    assert.deepEqual(config.search.hiddenEngineIds, ['weibo'])
    assert.deepEqual(config.search.aggregate.engines, ['bing'])
    assert.equal(config.search.providers.openclaw, undefined)
    assert.equal(JSON.stringify(config).includes('retired-provider-secret'), false)
  }

  assert.equal(stale.search.providers.openclaw.apiKey, 'retired-provider-secret')
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
