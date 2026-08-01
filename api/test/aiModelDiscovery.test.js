import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  AI_MODEL_CATALOG_LIMIT,
  createAiModelCatalog,
  resolveChatProviderModel,
  selectCliProxyChatModels,
  toPublicModelCatalogResponse
} from '../src/lib/aiModelCatalog.js'
import {
  AI_MODEL_MODES,
  normalizeCliProxyApiMode,
  normalizeCliProxyBaseUrl,
  readAiApiKeyFile,
  resolveChatProviderConfig,
  resolveConfiguredModelMode,
  validateAiSecretFileStat
} from '../src/lib/aiProviderConfig.js'
import { DEFAULT_OPENAI_MODEL } from '../src/lib/aiResponses.js'
import { validateAppConfigModelIds } from '../src/lib/aiModelSettings.js'
import { createApp } from '../src/app.js'

function modelPayload(ids) {
  return {
    object: 'list',
    data: ids.map((id, index) => ({
      id,
      object: 'model',
      created: 1000 + index,
      owned_by: 'cli-proxy'
    }))
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  })
}

function provider(overrides = {}) {
  return {
    enabled: true,
    mode: 'proxy',
    apiMode: 'chat-completions',
    cliProxyBaseUrl: 'https://proxy.example.test',
    apiKey: 'test-only-secret',
    model: DEFAULT_OPENAI_MODEL,
    ...overrides
  }
}

test('CLI Proxy base URL requires HTTPS and strips known OpenAI endpoint suffixes', () => {
  assert.equal(
    normalizeCliProxyBaseUrl('https://proxy.example.test/v1/chat/completions'),
    'https://proxy.example.test'
  )
  assert.equal(
    normalizeCliProxyBaseUrl('https://proxy.example.test/gateway/v1'),
    'https://proxy.example.test/gateway'
  )

  for (const value of [
    'http://proxy.example.test',
    'https://user:secret@proxy.example.test',
    'https://proxy.example.test?key=secret'
  ]) {
    assert.throws(() => normalizeCliProxyBaseUrl(value))
  }
})

test('CLI Proxy API mode is explicit and rejects unknown values', () => {
  assert.equal(normalizeCliProxyApiMode('responses'), 'responses')
  assert.equal(normalizeCliProxyApiMode(''), 'chat-completions')
  assert.throws(
    () => normalizeCliProxyApiMode('automatic'),
    /must be responses or chat-completions/
  )
})

test('model discovery recommends the newest stable general GPT and bounds output', () => {
  const result = selectCliProxyChatModels(modelPayload([
    'gpt-5.7-mini',
    'gpt-5.6-terra',
    'gpt-5.7-preview',
    'gpt-5.7-codex',
    'gpt-5.7-realtime',
    'gpt-image-2',
    'gpt-5.7',
    'gpt-5.4',
    'GPT-5.7'
  ]))

  assert.equal(result.latestModelId, 'gpt-5.7')
  assert.equal(result.models[0].id, 'gpt-5.7')
  assert.ok(result.models.length <= AI_MODEL_CATALOG_LIMIT)
  assert.equal(result.models.some(({ id }) => /codex|realtime|image/i.test(id)), false)
  assert.equal(
    new Set(result.models.map(({ id }) => id.toLowerCase())).size,
    result.models.length
  )
})

test('automatic selection prefers a stable general model over a newer mini or preview', () => {
  const result = selectCliProxyChatModels(modelPayload([
    'gpt-5.7-mini',
    'gpt-5.7-preview',
    'gpt-5.6-terra',
    'gpt-5.6-nano'
  ]))

  assert.equal(result.latestModelId, 'gpt-5.6-terra')
  assert.equal(result.models[0].id, 'gpt-5.6-terra')
})

test('same-version automatic selection prefers bare, sol, high, terra, then luna', () => {
  const currentProxy = selectCliProxyChatModels(modelPayload([
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-high',
    'gpt-5.6-sol'
  ]))
  assert.equal(currentProxy.latestModelId, 'gpt-5.6-sol')

  const futureProxy = selectCliProxyChatModels(modelPayload([
    'gpt-5.6-sol',
    'gpt-5.7-luna',
    'gpt-5.7-terra',
    'gpt-5.7-sol'
  ]))
  assert.equal(futureProxy.latestModelId, 'gpt-5.7-sol')

  const bareAlias = selectCliProxyChatModels(modelPayload([
    'gpt-5.7-sol',
    'gpt-5.7'
  ]))
  assert.equal(bareAlias.latestModelId, 'gpt-5.7')
})

test('automatic selection ignores dated snapshots even when their date looks like a patch version', () => {
  const result = selectCliProxyChatModels(modelPayload([
    'gpt-5.6-2026-07-01',
    'gpt-5.6.1-2026-07-01',
    'gpt-5.6-sol',
    'gpt-5.5'
  ]))

  assert.equal(result.latestModelId, 'gpt-5.6-sol')
  assert.equal(result.models[0].id, 'gpt-5.6-sol')
  assert.equal(
    result.models.find(({ id }) => id === 'gpt-5.6-2026-07-01')?.description,
    '日期快照'
  )
})

test('automatic selection returns no recommendation when only unstable or lightweight models exist', () => {
  const result = selectCliProxyChatModels(modelPayload([
    'gpt-5.7-preview',
    'gpt-5.7-mini',
    'gpt-5.6-2026-07-01'
  ]))

  assert.equal(result.latestModelId, '')
  assert.equal(result.models.length, 3)
})

test('model catalog deduplicates concurrent refreshes and serves fresh cache', async () => {
  let nowValue = 10_000
  let fetchCount = 0
  let releaseFetch
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve
  })
  const catalog = createAiModelCatalog({
    now: () => nowValue,
    freshMs: 1000,
    staleMs: 10_000,
    assertEndpointImpl: async (value) => new URL(value),
    fetchImpl: async () => {
      fetchCount += 1
      await fetchGate
      return jsonResponse(modelPayload(['gpt-5.7', 'gpt-5.6-terra']))
    }
  })

  const first = catalog.discover(provider())
  const second = catalog.discover(provider())
  releaseFetch()

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(fetchCount, 1)
  assert.equal(firstResult.source, 'live')
  assert.equal(secondResult.source, 'live')

  nowValue += 500
  const cached = await catalog.discover(provider())
  assert.equal(cached.source, 'cache')
  assert.equal(fetchCount, 1)
})

test('model catalog uses stale data before falling back to configured model', async () => {
  let nowValue = 50_000
  let shouldFail = false
  const catalog = createAiModelCatalog({
    now: () => nowValue,
    freshMs: 100,
    staleMs: 1000,
    assertEndpointImpl: async (value) => new URL(value),
    fetchImpl: async () => {
      if (shouldFail) throw new Error('upstream unavailable')
      return jsonResponse(modelPayload(['gpt-5.7', 'gpt-5.6-terra']))
    }
  })

  const live = await catalog.discover(provider())
  assert.equal(live.source, 'live')

  shouldFail = true
  nowValue += 101
  const stale = await catalog.discover(provider())
  assert.equal(stale.source, 'stale')
  assert.equal(stale.latestModelId, 'gpt-5.7')

  nowValue += 1001
  const fallback = await catalog.discover(provider())
  assert.equal(fallback.source, 'fallback')
  assert.equal(fallback.latestModelId, DEFAULT_OPENAI_MODEL)
})

test('model catalog rejects unsafe destinations and oversized payloads without leaking errors', async () => {
  let fetchCount = 0
  const blockedCatalog = createAiModelCatalog({
    assertEndpointImpl: async () => {
      throw new Error('private network blocked')
    },
    fetchImpl: async () => {
      fetchCount += 1
      return jsonResponse(modelPayload(['gpt-5.7']))
    }
  })

  const blocked = await blockedCatalog.discover(provider())
  assert.equal(blocked.source, 'fallback')
  assert.equal(fetchCount, 0)

  const oversizedCatalog = createAiModelCatalog({
    maxBytes: 32,
    assertEndpointImpl: async (value) => new URL(value),
    fetchImpl: async () => jsonResponse(modelPayload([
      'gpt-5.7',
      'gpt-5.6-terra'
    ]))
  })
  const oversized = await oversizedCatalog.discover(provider({
    cliProxyBaseUrl: 'https://oversized.example.test'
  }))

  assert.equal(oversized.source, 'fallback')
  assert.equal(JSON.stringify(oversized).includes('private network blocked'), false)
})

test('model discovery timeout returns the configured fallback', async () => {
  const catalog = createAiModelCatalog({
    timeoutMs: 1,
    assertEndpointImpl: async (value) => new URL(value),
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  })

  const result = await catalog.discover(provider())
  assert.equal(result.source, 'fallback')
  assert.equal(result.latestModelId, DEFAULT_OPENAI_MODEL)
})

test('model cache remains bounded across distinct proxy credentials and destinations', async () => {
  const catalog = createAiModelCatalog({
    maxEntries: 2,
    assertEndpointImpl: async (value) => new URL(value),
    fetchImpl: async () => jsonResponse(modelPayload(['gpt-5.7']))
  })

  for (let index = 0; index < 4; index += 1) {
    await catalog.discover(provider({
      cliProxyBaseUrl: `https://proxy-${index}.example.test`,
      apiKey: `test-secret-${index}`
    }))
  }

  assert.ok(catalog.size <= 2)
})

test('latest and pinned modes remain backward compatible while sharing one resolver', async () => {
  let discoverCount = 0
  const fakeCatalog = {
    async discover() {
      discoverCount += 1
      return {
        models: [{
          id: 'gpt-5.7',
          label: 'gpt-5.7',
          description: '自动推荐'
        }],
        latestModelId: 'gpt-5.7',
        source: 'live',
        stale: false,
        verifiedAt: new Date(0).toISOString()
      }
    }
  }
  const noServerConfig = {
    aiCliProxyBaseUrl: '',
    aiCliProxyApiKeyFile: ''
  }

  const automatic = await resolveChatProviderModel(provider(), {
    runtimeConfig: noServerConfig,
    catalog: fakeCatalog
  })
  assert.equal(automatic.provider.modelMode, AI_MODEL_MODES.LATEST)
  assert.equal(automatic.provider.model, 'gpt-5.7')
  assert.equal(discoverCount, 1)

  const pinned = await resolveChatProviderModel(provider({
    model: 'custom/gpt-stable',
    modelMode: AI_MODEL_MODES.PINNED
  }), {
    runtimeConfig: noServerConfig,
    catalog: fakeCatalog
  })
  assert.equal(pinned.provider.model, 'custom/gpt-stable')
  assert.equal(discoverCount, 1)
  assert.equal(resolveConfiguredModelMode({ model: 'custom/gpt-stable' }), 'pinned')
})

test('settings accept only latest or pinned model modes', () => {
  for (const modelMode of ['', 'latest', 'pinned']) {
    assert.doesNotThrow(() => validateAppConfigModelIds({
      search: {
        providers: {
          chatgpt: {
            modelMode,
            model: DEFAULT_OPENAI_MODEL
          }
        }
      }
    }))
  }

  assert.throws(
    () => validateAppConfigModelIds({
      search: {
        providers: {
          chatgpt: {
            modelMode: 'automatic-ish',
            model: DEFAULT_OPENAI_MODEL
          }
        }
      }
    }),
    /模型选择模式无效/
  )
})

test('server-managed provider reads an owner-only secret file and public catalog omits it', async () => {
  const secret = 'server-only-cli-proxy-secret'
  const resolved = await resolveChatProviderConfig({
    enabled: false,
    model: DEFAULT_OPENAI_MODEL
  }, {
    runtimeConfig: {
      aiCliProxyBaseUrl: 'https://proxy.example.test/v1',
      aiCliProxyApiMode: 'responses',
      aiCliProxyApiKeyFile: '/run/secrets/nav/cli-proxy-api-key'
    },
    readSecretImpl: async () => secret
  })

  assert.equal(resolved.enabled, true)
  assert.equal(resolved.mode, 'proxy')
  assert.equal(resolved.cliProxyBaseUrl, 'https://proxy.example.test')
  assert.equal(resolved.apiMode, 'responses')
  assert.equal(resolved.apiKey, secret)
  assert.equal(resolved.serverManaged, true)

  const publicResponse = toPublicModelCatalogResponse({
    models: [{ id: 'gpt-5.7' }],
    latestModelId: 'gpt-5.7',
    resolvedModelId: 'gpt-5.7',
    configuredMode: 'latest',
    apiMode: 'responses',
    source: 'live',
    stale: false,
    verifiedAt: new Date(0).toISOString(),
    serverManaged: true,
    apiKey: secret,
    authorization: `Bearer ${secret}`
  })

  assert.equal(publicResponse.serverManaged, true)
  assert.equal(publicResponse.apiMode, 'responses')
  assert.equal(JSON.stringify(publicResponse).includes(secret), false)
  assert.equal('apiKey' in publicResponse, false)
  assert.equal('authorization' in publicResponse, false)
})

test('secret file validation accepts 0400 or 0600 and rejects group, world, or execute access', async () => {
  const makeStat = (mode) => ({
    mode,
    size: 20,
    isFile: () => true
  })

  assert.doesNotThrow(() => validateAiSecretFileStat(makeStat(0o100600), {
    platform: 'linux'
  }))
  assert.doesNotThrow(() => validateAiSecretFileStat(makeStat(0o100400), {
    platform: 'linux'
  }))

  for (const mode of [0o100640, 0o100604, 0o100700]) {
    assert.throws(
      () => validateAiSecretFileStat(makeStat(mode), { platform: 'linux' }),
      /owner-only permissions/
    )
  }

  const secret = await readAiApiKeyFile('/secret', {
    platform: 'linux',
    lstatImpl: async () => ({
      ...makeStat(0o100600),
      dev: 1,
      ino: 2,
      isSymbolicLink: () => false
    }),
    openImpl: async () => ({
      stat: async () => ({
        ...makeStat(0o100600),
        dev: 1,
        ino: 2
      }),
      read: async (buffer, _offset, _length, position) => {
        const content = Buffer.from('test-only-api-key\n')
        const bytesRead = position === 0 ? content.length : 0
        if (bytesRead) content.copy(buffer)
        return { bytesRead, buffer }
      },
      close: async () => {}
    })
  })
  assert.equal(secret, 'test-only-api-key')
})

test('secret file reader rejects symlinks and file replacement races', async () => {
  const makeStat = ({
    dev = 1,
    ino = 2,
    symbolicLink = false
  } = {}) => ({
    dev,
    ino,
    mode: 0o100600,
    size: 20,
    isFile: () => !symbolicLink,
    isSymbolicLink: () => symbolicLink
  })

  await assert.rejects(
    () => readAiApiKeyFile('/secret', {
      platform: 'linux',
      lstatImpl: async () => makeStat({ symbolicLink: true })
    }),
    /cannot be a symbolic link/
  )

  await assert.rejects(
    () => readAiApiKeyFile('/secret', {
      platform: 'linux',
      lstatImpl: async () => makeStat(),
      openImpl: async () => ({
        stat: async () => makeStat({ ino: 3 }),
        close: async () => {}
      })
    }),
    /changed while opening/
  )
})

test('model catalog route requires authentication before settings or secrets are read', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ai-search/providers/chatgpt/models'
    })

    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'Authentication required')
  } finally {
    await app.close()
  }
})

test('AI search, note editing, and bookmark tags all use the shared model resolver', async () => {
  const sourceUrls = [
    new URL('../src/routes/aiSearch.js', import.meta.url),
    new URL('../src/routes/noteAi.js', import.meta.url),
    new URL('../src/routes/navigation.js', import.meta.url)
  ]

  for (const sourceUrl of sourceUrls) {
    const source = await fs.readFile(sourceUrl, 'utf8')
    assert.match(source, /resolveChatProviderModel/)
  }
})
