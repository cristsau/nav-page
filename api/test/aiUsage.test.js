import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_USAGE_FEATURES,
  buildAiUsageCsv,
  estimateAiCostMicrousd,
  findAiPrice,
  normalizeAiUsage,
  parseAiPriceCatalog,
  recordAiUsage,
  summarizeAiUsageRows
} from '../src/lib/aiUsage.js'

test('Responses and Chat Completions token payloads normalize to one schema', () => {
  assert.deepEqual(normalizeAiUsage({
    input_tokens: 120,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 10 }
  }), {
    inputTokens: 120,
    outputTokens: 30,
    cachedInputTokens: 20,
    reasoningTokens: 10
  })
  assert.deepEqual(normalizeAiUsage({
    prompt_tokens: 50,
    completion_tokens: 12,
    prompt_tokens_details: { cached_tokens: 5 }
  }), {
    inputTokens: 50,
    outputTokens: 12,
    cachedInputTokens: 5,
    reasoningTokens: 0
  })
})

test('cost exists only when an optional verified price entry matches', () => {
  const catalog = parseAiPriceCatalog(JSON.stringify({
    'chatgpt:gpt-test': {
      inputPerMillionUsd: 2,
      cachedInputPerMillionUsd: 1,
      outputPerMillionUsd: 8
    }
  }), { strict: true })
  assert.equal(estimateAiCostMicrousd({
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
    price: catalog['chatgpt:gpt-test']
  }), 260)
  assert.equal(estimateAiCostMicrousd({ usage: {}, price: null }), null)
  assert.equal(findAiPrice({}, 'chatgpt', 'toString'), null)
})

test('daily recorder writes bounded aggregates but never prompt or answer content', async () => {
  const calls = []
  const recorded = await recordAiUsage({
    userId: '00000000-0000-4000-8000-000000000001',
    feature: AI_USAGE_FEATURES.ASSISTANT,
    provider: 'chatgpt',
    model: 'gpt-test',
    apiMode: 'responses',
    success: true,
    usage: { input_tokens: 12, output_tokens: 4 },
    latencyMs: 345,
    priceCatalog: {},
    async queryFn(sql, params) {
      calls.push({ sql, params })
      return { rowCount: 1, rows: [] }
    }
  })

  assert.equal(calls.length, 1)
  assert.equal(recorded.costKnown, false)
  assert.deepEqual(calls[0].params.slice(1, 5), [
    'assistant',
    'chatgpt',
    'gpt-test',
    'responses'
  ])
  assert.doesNotMatch(calls[0].sql, /prompt|answer|content/i)
  assert.equal(calls[0].params.includes('private prompt'), false)
})

test('usage summary marks absent and partial pricing honestly', () => {
  const summary = summarizeAiUsageRows([
    {
      usage_date: '2026-08-24',
      feature: 'assistant',
      provider: 'chatgpt',
      model: 'gpt-test',
      api_mode: 'responses',
      request_count: 2,
      success_count: 1,
      failure_count: 1,
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 0,
      reasoning_tokens: 5,
      latency_ms_total: 500,
      estimated_cost_microusd: 200,
      priced_request_count: 1
    }
  ], 30)
  assert.equal(summary.totals.cost.known, false)
  assert.equal(summary.totals.cost.partial, true)
  assert.equal(summary.totals.cost.estimatedUsd, 0.0002)
  assert.equal(summary.totals.averageLatencyMs, 250)
})

test('CSV export prevents spreadsheet formula execution and shows unknown price', () => {
  const csv = buildAiUsageCsv([{
    usage_date: '2026-08-24',
    feature: 'assistant',
    provider: 'chatgpt',
    model: '=CMD()',
    api_mode: 'responses',
    request_count: 1,
    success_count: 1,
    failure_count: 0,
    input_tokens: 1,
    output_tokens: 1,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    latency_ms_total: 10,
    estimated_cost_microusd: 0,
    priced_request_count: 0
  }])
  assert.match(csv, /'=CMD\(\)/)
  assert.match(csv, /priced_requests,cost_status,estimated_cost_usd/)
  assert.match(csv, /unknown/)
})

test('CSV export marks partially priced rows without presenting them as fully known', () => {
  const csv = buildAiUsageCsv([{
    usage_date: '2026-08-24',
    feature: 'assistant',
    provider: 'chatgpt',
    model: 'gpt-test',
    api_mode: 'responses',
    request_count: 2,
    success_count: 1,
    failure_count: 1,
    input_tokens: 10,
    output_tokens: 4,
    cached_input_tokens: 0,
    reasoning_tokens: 0,
    latency_ms_total: 20,
    estimated_cost_microusd: 50,
    priced_request_count: 1
  }])
  assert.match(csv, /,1,partial,0\.000050/)
})
