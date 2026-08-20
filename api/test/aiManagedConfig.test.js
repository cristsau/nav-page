import test from 'node:test'
import assert from 'node:assert/strict'
import { buildModelsEndpoint } from '../src/lib/aiModelCatalog.js'
import { resolveChatProviderConfig } from '../src/lib/aiProviderConfig.js'
import { DEFAULT_OPENAI_MODEL } from '../src/lib/aiResponses.js'

test('custom AI source never reads or reuses the server-managed secret', async () => {
  let secretReads = 0
  const resolved = await resolveChatProviderConfig({
    enabled: true,
    useServerManaged: false,
    mode: 'api',
    apiMode: 'responses',
    endpoint: 'https://custom.example.test/v1/responses',
    apiKey: 'custom-only-secret',
    model: DEFAULT_OPENAI_MODEL
  }, {
    runtimeConfig: {
      aiCliProxyBaseUrl: 'https://proxy.example.test/v1',
      aiCliProxyApiMode: 'responses',
      aiCliProxyApiKeyFile: '/run/secrets/nav/cli-proxy-api-key'
    },
    readSecretImpl: async () => {
      secretReads += 1
      return 'server-only-secret'
    }
  })

  assert.equal(secretReads, 0)
  assert.equal(resolved.serverManaged, false)
  assert.equal(resolved.serverManagedAvailable, true)
  assert.equal(resolved.mode, 'api')
  assert.equal(resolved.endpoint, 'https://custom.example.test/v1/responses')
  assert.equal(resolved.apiKey, 'custom-only-secret')
  assert.equal(resolved.managedEndpoint, 'https://proxy.example.test/v1/responses')
})

test('custom AI source remains usable when the optional server configuration is incomplete', async () => {
  const resolved = await resolveChatProviderConfig({
    enabled: true,
    useServerManaged: false,
    mode: 'api',
    endpoint: 'https://custom.example.test/v1/responses',
    apiKey: 'custom-only-secret'
  }, {
    runtimeConfig: {
      aiCliProxyBaseUrl: 'https://unfinished.example.test',
      aiCliProxyApiMode: 'responses',
      aiCliProxyApiKeyFile: ''
    },
    readSecretImpl: async () => {
      throw new Error('server secret must not be read')
    }
  })

  assert.equal(resolved.serverManaged, false)
  assert.equal(resolved.serverManagedAvailable, false)
  assert.equal(resolved.managedBaseUrl, '')
})

test('custom API model discovery follows the active endpoint instead of a stale proxy URL', () => {
  assert.equal(buildModelsEndpoint({
    mode: 'api',
    endpoint: 'https://custom.example.test/v1/responses',
    cliProxyBaseUrl: 'https://stale-proxy.example.test'
  }), 'https://custom.example.test/v1/models')
})
