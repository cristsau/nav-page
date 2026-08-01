import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  CHAT_MODEL_CATALOG,
  DEFAULT_CHAT_MODEL_ID,
  getChatModelOptions,
  resolveConfiguredChatApiMode
} from '../../app/src/shared/config/aiModels.js'
import {
  DEFAULT_OPENAI_MODEL,
  buildChatRequest,
  normalizeAiModelId,
  resolveChatApiMode,
  resolveChatEndpoint
} from '../src/lib/aiResponses.js'
import { validateAppConfigModelIds } from '../src/lib/aiModelSettings.js'

test('chat model catalog exposes six unique verified proxy models', () => {
  assert.equal(CHAT_MODEL_CATALOG.length, 6)
  assert.equal(new Set(CHAT_MODEL_CATALOG.map(({ id }) => id)).size, 6)
  assert.equal(CHAT_MODEL_CATALOG[0].id, 'gpt-5.6-sol')
  assert.equal(DEFAULT_CHAT_MODEL_ID, DEFAULT_OPENAI_MODEL)
  assert.equal(
    CHAT_MODEL_CATALOG.every(({ description }) => description.includes('代理已验证')),
    true
  )
})

test('legacy configured model is preserved without expanding the picker past six items', () => {
  const options = getChatModelOptions('custom/model-v2')

  assert.equal(options.length, 6)
  assert.equal(options[0].id, 'custom/model-v2')
  assert.equal(options[0].description, '当前兼容配置')
  assert.equal(getChatModelOptions(DEFAULT_CHAT_MODEL_ID), CHAT_MODEL_CATALOG)
})

test('catalog model IDs pass through Chat Completions exactly', () => {
  for (const { id } of CHAT_MODEL_CATALOG) {
    const request = buildChatRequest(
      {
        mode: 'proxy',
        cliProxyBaseUrl: 'https://proxy.example.test',
        apiMode: 'chat-completions',
        model: id
      },
      'query',
      'system'
    )

    assert.equal(request.model, id)
    assert.equal(request.body.model, id)
  }
})

test('model IDs preserve compatible legacy characters but reject controls and excessive length', () => {
  for (const value of [
    'gpt 5.6 terra',
    '自定义模型/稳定版',
    'gateway/model#preview?mode=high'
  ]) {
    assert.equal(normalizeAiModelId(value), value)
  }

  for (const value of [
    'gpt-5.6\nterra',
    'gpt-5.6\u200Bterra',
    `gpt-${'x'.repeat(260)}`
  ]) {
    assert.throws(
      () => normalizeAiModelId(value),
      /模型 ID 格式无效/
    )
  }
})

test('settings model validation accepts catalog, blank and safe legacy IDs', () => {
  for (const model of [
    '',
    ...CHAT_MODEL_CATALOG.map(({ id }) => id),
    'custom/model-v2@edge',
    'gpt 5 typo',
    '自定义模型/稳定版',
    'gateway/model#preview?mode=high'
  ]) {
    assert.doesNotThrow(() => validateAppConfigModelIds({
      search: {
        providers: {
          chatgpt: { model }
        }
      }
    }))
  }
})

test('settings model validation rejects controls and excessive length', () => {
  for (const model of [
    'gpt-5.4\ninjected',
    `gpt-${'x'.repeat(260)}`
  ]) {
    const runValidation = () => validateAppConfigModelIds({
      search: {
        providers: {
          chatgpt: { model }
        }
      }
    })

    assert.throws(runValidation, /模型 ID 格式无效/)
  }
})

test('settings API mode inference mirrors backend endpoint precedence', () => {
  const providers = [
    {
      mode: 'api',
      apiMode: '',
      endpoint: 'https://api.example.test/v1/chat/completions',
      cliProxyBaseUrl: ''
    },
    {
      mode: 'api',
      apiMode: '',
      endpoint: 'https://api.example.test/v1/responses',
      cliProxyBaseUrl: 'https://stale-proxy.example.test'
    },
    {
      mode: 'proxy',
      apiMode: '',
      endpoint: 'https://api.example.test/v1/responses',
      cliProxyBaseUrl: 'https://proxy.example.test'
    },
    {
      mode: 'proxy',
      apiMode: 'responses',
      endpoint: 'https://api.example.test/v1/chat/completions',
      cliProxyBaseUrl: 'https://proxy.example.test'
    },
    {
      mode: 'api',
      apiMode: '',
      endpoint: '',
      cliProxyBaseUrl: ''
    }
  ]

  for (const provider of providers) {
    const backendMode = resolveChatApiMode(provider, resolveChatEndpoint(provider))
    assert.equal(resolveConfiguredChatApiMode(provider), backendMode)
  }
})

test('settings route sanitizes retired providers before validating and storing appConfig', async () => {
  const settingsUrl = new URL('../src/routes/settings.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(settingsUrl), 'utf8')
  const sanitizationIndex = source.indexOf(
    'sanitizeRetiredSearchProviders(requestedValue)'
  )
  const validationIndex = source.indexOf(
    'validateAppConfigModelIds(sanitizedRequestedValue)'
  )
  const mergeIndex = source.indexOf('value = mergeAppConfigSecrets(')

  assert.ok(sanitizationIndex >= 0)
  assert.ok(validationIndex > sanitizationIndex)
  assert.ok(mergeIndex > validationIndex)
})

test('settings renders the chat model as a bounded select and explains inactive options', async () => {
  const settingsUrl = new URL(
    '../../app/src/modules/settings/components/SearchSettings.vue',
    import.meta.url
  )
  const source = await fs.readFile(fileURLToPath(settingsUrl), 'utf8')
  const modelField = source.match(/<span>Model<\/span>([\s\S]*?)<\/label>/)?.[1] || ''

  assert.match(modelField, /<select/)
  assert.match(modelField, /v-for="model in chatModelOptions"/)
  assert.doesNotMatch(modelField, /type="text"/)
  assert.match(source, /最多显示 6 个/)
  assert.match(source, /推理强度和内置联网搜索参数不会发送/)
  assert.match(source, /:value="chatApiMode"/)
  assert.doesNotMatch(source, /apiMode \|\| \(config\.search/)
})
