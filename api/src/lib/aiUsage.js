export const AI_USAGE_FEATURES = Object.freeze({
  WEB_SEARCH: 'web_search',
  BOOKMARK_ANALYSIS: 'bookmark_analysis',
  BOOKMARK_TAGS: 'bookmark_tags',
  NOTE_SUMMARIZE: 'note_summarize',
  NOTE_POLISH: 'note_polish',
  NOTE_TASKS: 'note_tasks',
  NOTE_CONTINUE: 'note_continue',
  NOTE_TAGS: 'note_tags',
  ASSISTANT: 'assistant',
  EMAIL_CLASSIFICATION: 'email_classification',
  EMAIL_ASSIST: 'email_assist',
  PROVIDER_TEST: 'provider_test'
})

export const AI_USAGE_RANGES = Object.freeze([7, 30, 90])

const FEATURE_VALUES = new Set(Object.values(AI_USAGE_FEATURES))
const MAX_TOKEN_COUNT = 10_000_000_000
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000
const MAX_PRICE_PER_MILLION_USD = 1_000_000

export const RECORD_AI_USAGE_SQL = `
  INSERT INTO ai_usage_daily (
    usage_date,
    user_id,
    feature,
    provider,
    model,
    api_mode,
    request_count,
    success_count,
    failure_count,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    reasoning_tokens,
    latency_ms_total,
    estimated_cost_microusd,
    priced_request_count,
    updated_at
  )
  VALUES (
    CURRENT_DATE,
    $1,
    $2,
    $3,
    $4,
    $5,
    1,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    NOW()
  )
  ON CONFLICT (usage_date, user_id, feature, provider, model, api_mode)
  DO UPDATE SET
    request_count = ai_usage_daily.request_count + 1,
    success_count = ai_usage_daily.success_count + EXCLUDED.success_count,
    failure_count = ai_usage_daily.failure_count + EXCLUDED.failure_count,
    input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
    output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
    cached_input_tokens = ai_usage_daily.cached_input_tokens + EXCLUDED.cached_input_tokens,
    reasoning_tokens = ai_usage_daily.reasoning_tokens + EXCLUDED.reasoning_tokens,
    latency_ms_total = ai_usage_daily.latency_ms_total + EXCLUDED.latency_ms_total,
    estimated_cost_microusd = ai_usage_daily.estimated_cost_microusd
      + EXCLUDED.estimated_cost_microusd,
    priced_request_count = ai_usage_daily.priced_request_count
      + EXCLUDED.priced_request_count,
    updated_at = NOW()
`

export const SELECT_AI_USAGE_SQL = `
  SELECT
    usage_date::text AS usage_date,
    feature,
    provider,
    model,
    api_mode,
    request_count,
    success_count,
    failure_count,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    reasoning_tokens,
    latency_ms_total,
    estimated_cost_microusd,
    priced_request_count
  FROM ai_usage_daily
  WHERE user_id = $1
    AND usage_date >= CURRENT_DATE - ($2::integer - 1)
  ORDER BY usage_date ASC, feature ASC, provider ASC, model ASC, api_mode ASC
`

function boundedInteger(value, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(Math.round(parsed), maximum)
}

function firstDefined(object, paths) {
  for (const path of paths) {
    let current = object
    for (const segment of path) current = current?.[segment]
    if (current !== undefined && current !== null) return current
  }
  return 0
}

export function normalizeAiUsage(rawUsage = {}) {
  const inputTokens = boundedInteger(firstDefined(rawUsage, [
    ['input_tokens'],
    ['prompt_tokens'],
    ['inputTokens'],
    ['promptTokens']
  ]), MAX_TOKEN_COUNT)
  const outputTokens = boundedInteger(firstDefined(rawUsage, [
    ['output_tokens'],
    ['completion_tokens'],
    ['outputTokens'],
    ['completionTokens']
  ]), MAX_TOKEN_COUNT)
  const cachedInputTokens = Math.min(inputTokens, boundedInteger(firstDefined(rawUsage, [
    ['cachedInputTokens'],
    ['input_tokens_details', 'cached_tokens'],
    ['prompt_tokens_details', 'cached_tokens'],
    ['inputTokensDetails', 'cachedTokens'],
    ['promptTokensDetails', 'cachedTokens']
  ]), MAX_TOKEN_COUNT))
  const reasoningTokens = Math.min(outputTokens, boundedInteger(firstDefined(rawUsage, [
    ['reasoningTokens'],
    ['output_tokens_details', 'reasoning_tokens'],
    ['completion_tokens_details', 'reasoning_tokens'],
    ['outputTokensDetails', 'reasoningTokens'],
    ['completionTokensDetails', 'reasoningTokens']
  ]), MAX_TOKEN_COUNT))

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens
  }
}

function normalizePrice(value, field, strict) {
  const price = Number(value)
  if (
    !Number.isFinite(price)
    || price < 0
    || price > MAX_PRICE_PER_MILLION_USD
  ) {
    if (strict) throw new Error(`${field} must be a non-negative USD price per million tokens`)
    return null
  }
  return price
}

export function parseAiPriceCatalog(value, { strict = false } = {}) {
  if (!value) return {}
  let source = value
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value)
    } catch {
      if (strict) throw new Error('NAV_AI_PRICE_CATALOG_JSON must be valid JSON')
      return {}
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    if (strict) throw new Error('AI price catalog must be an object')
    return {}
  }

  const catalog = Object.create(null)
  for (const [rawKey, rawPrice] of Object.entries(source)) {
    const key = String(rawKey || '').trim()
    if (!key || key.length > 384 || !rawPrice || typeof rawPrice !== 'object') {
      if (strict) throw new Error('AI price catalog contains an invalid entry')
      continue
    }
    const input = normalizePrice(rawPrice.inputPerMillionUsd, 'inputPerMillionUsd', strict)
    const cachedInput = rawPrice.cachedInputPerMillionUsd === undefined
      ? input
      : normalizePrice(rawPrice.cachedInputPerMillionUsd, 'cachedInputPerMillionUsd', strict)
    const output = normalizePrice(rawPrice.outputPerMillionUsd, 'outputPerMillionUsd', strict)
    if ([input, cachedInput, output].some((item) => item === null)) continue
    catalog[key] = { input, cachedInput, output }
  }
  return catalog
}

export function findAiPrice(catalog, provider, model) {
  const safeCatalog = catalog && typeof catalog === 'object' ? catalog : {}
  const candidates = [
    `${provider}:${model}`,
    model,
    `${provider}:*`,
    '*'
  ]
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(safeCatalog, key)) {
      return safeCatalog[key]
    }
  }
  return null
}

export function estimateAiCostMicrousd({ usage, price }) {
  if (!price) return null
  const normalized = normalizeAiUsage(usage)
  const uncachedInput = Math.max(0, normalized.inputTokens - normalized.cachedInputTokens)
  // USD per million tokens numerically equals micro-USD per token.
  return Math.max(0, Math.round(
    uncachedInput * price.input
      + normalized.cachedInputTokens * price.cachedInput
      + normalized.outputTokens * price.output
  ))
}

function normalizeDimension(value, fallback, pattern, maxLength) {
  const normalized = String(value || fallback).trim().slice(0, maxLength)
  return pattern.test(normalized) ? normalized : fallback
}

export function normalizeAiUsageFeature(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return FEATURE_VALUES.has(normalized) ? normalized : AI_USAGE_FEATURES.WEB_SEARCH
}

function normalizeUsageDimensions({ feature, provider, model, apiMode }) {
  return {
    feature: normalizeAiUsageFeature(feature),
    provider: normalizeDimension(
      String(provider || '').toLowerCase(),
      'unknown',
      /^[a-z0-9_.-]+$/,
      64
    ),
    model: String(model || 'unknown')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, 256) || 'unknown',
    apiMode: normalizeDimension(
      String(apiMode || '').toLowerCase(),
      'unknown',
      /^[a-z0-9_.-]+$/,
      32
    )
  }
}

export async function recordAiUsage({
  userId,
  feature,
  provider,
  model,
  apiMode,
  success,
  usage,
  latencyMs,
  queryFn,
  priceCatalog = {}
}) {
  if (typeof queryFn !== 'function') throw new TypeError('queryFn is required')
  const dimensions = normalizeUsageDimensions({ feature, provider, model, apiMode })
  const normalizedUsage = normalizeAiUsage(usage)
  const price = success
    ? findAiPrice(priceCatalog, dimensions.provider, dimensions.model)
    : null
  const estimatedCostMicrousd = estimateAiCostMicrousd({
    usage: normalizedUsage,
    price
  })

  await queryFn(RECORD_AI_USAGE_SQL, [
    userId,
    dimensions.feature,
    dimensions.provider,
    dimensions.model,
    dimensions.apiMode,
    success ? 1 : 0,
    success ? 0 : 1,
    normalizedUsage.inputTokens,
    normalizedUsage.outputTokens,
    normalizedUsage.cachedInputTokens,
    normalizedUsage.reasoningTokens,
    boundedInteger(latencyMs, MAX_LATENCY_MS),
    estimatedCostMicrousd ?? 0,
    estimatedCostMicrousd === null ? 0 : 1
  ])

  return {
    ...dimensions,
    ...normalizedUsage,
    estimatedCostMicrousd,
    costKnown: estimatedCostMicrousd !== null
  }
}

export async function recordAiUsageSafely(payload, logger) {
  try {
    return await recordAiUsage(payload)
  } catch (error) {
    logger?.warn?.(
      {
        err: error,
        feature: normalizeAiUsageFeature(payload?.feature)
      },
      'AI usage aggregate could not be recorded'
    )
    return null
  }
}

export function normalizeAiUsageRange(value) {
  const parsed = Number(value)
  return AI_USAGE_RANGES.includes(parsed) ? parsed : 30
}

function rowNumber(row, field) {
  return boundedInteger(row?.[field], Number.MAX_SAFE_INTEGER)
}

function addMetrics(target, row) {
  target.requestCount += rowNumber(row, 'request_count')
  target.successCount += rowNumber(row, 'success_count')
  target.failureCount += rowNumber(row, 'failure_count')
  target.inputTokens += rowNumber(row, 'input_tokens')
  target.outputTokens += rowNumber(row, 'output_tokens')
  target.cachedInputTokens += rowNumber(row, 'cached_input_tokens')
  target.reasoningTokens += rowNumber(row, 'reasoning_tokens')
  target.latencyMsTotal += rowNumber(row, 'latency_ms_total')
  target.estimatedCostMicrousd += rowNumber(row, 'estimated_cost_microusd')
  target.pricedRequestCount += rowNumber(row, 'priced_request_count')
  return target
}

function emptyMetrics() {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    latencyMsTotal: 0,
    estimatedCostMicrousd: 0,
    pricedRequestCount: 0
  }
}

export function finalizeAiUsageMetrics(metrics) {
  return {
    ...metrics,
    averageLatencyMs: metrics.requestCount
      ? Math.round(metrics.latencyMsTotal / metrics.requestCount)
      : 0,
    cost: {
      known: metrics.requestCount > 0
        && metrics.pricedRequestCount === metrics.requestCount,
      partial: metrics.pricedRequestCount > 0
        && metrics.pricedRequestCount < metrics.requestCount,
      pricedRequestCount: metrics.pricedRequestCount,
      estimatedUsd: metrics.pricedRequestCount > 0
        ? Number((metrics.estimatedCostMicrousd / 1_000_000).toFixed(6))
        : null
    }
  }
}

export function summarizeAiUsageRows(rows = [], days = 30) {
  const totals = emptyMetrics()
  const daily = new Map()
  const breakdown = new Map()

  for (const row of rows) {
    addMetrics(totals, row)
    const date = String(row.usage_date || '')
    if (!daily.has(date)) daily.set(date, emptyMetrics())
    addMetrics(daily.get(date), row)

    const key = [row.feature, row.provider, row.model, row.api_mode].join('\u0000')
    if (!breakdown.has(key)) {
      breakdown.set(key, {
        feature: row.feature,
        provider: row.provider,
        model: row.model,
        apiMode: row.api_mode,
        metrics: emptyMetrics()
      })
    }
    addMetrics(breakdown.get(key).metrics, row)
  }

  return {
    days: normalizeAiUsageRange(days),
    totals: finalizeAiUsageMetrics(totals),
    daily: [...daily.entries()].map(([date, metrics]) => ({
      date,
      ...finalizeAiUsageMetrics(metrics)
    })),
    breakdown: [...breakdown.values()]
      .map((item) => ({
        ...item,
        ...finalizeAiUsageMetrics(item.metrics),
        metrics: undefined
      }))
      .sort((left, right) => (
        right.requestCount - left.requestCount
        || String(left.feature).localeCompare(String(right.feature))
        || String(left.model).localeCompare(String(right.model))
      ))
  }
}

export async function loadAiUsageSummary({ userId, days, queryFn }) {
  if (typeof queryFn !== 'function') throw new TypeError('queryFn is required')
  const rangeDays = normalizeAiUsageRange(days)
  const { rows } = await queryFn(SELECT_AI_USAGE_SQL, [userId, rangeDays])
  return summarizeAiUsageRows(rows, rangeDays)
}

function csvCell(value) {
  const raw = String(value ?? '')
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function buildAiUsageCsv(rows = []) {
  const header = [
    'date',
    'feature',
    'provider',
    'model',
    'api_mode',
    'requests',
    'successes',
    'failures',
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'reasoning_tokens',
    'average_latency_ms',
    'priced_requests',
    'cost_status',
    'estimated_cost_usd'
  ]
  const lines = rows.map((row) => {
    const requests = rowNumber(row, 'request_count')
    const pricedRequests = rowNumber(row, 'priced_request_count')
    const latency = rowNumber(row, 'latency_ms_total')
    const costStatus = pricedRequests === 0
      ? 'unknown'
      : pricedRequests < requests
        ? 'partial'
        : 'known'
    const cost = pricedRequests > 0
      ? (rowNumber(row, 'estimated_cost_microusd') / 1_000_000).toFixed(6)
      : 'unknown'
    return [
      row.usage_date,
      row.feature,
      row.provider,
      row.model,
      row.api_mode,
      requests,
      row.success_count,
      row.failure_count,
      row.input_tokens,
      row.output_tokens,
      row.cached_input_tokens,
      row.reasoning_tokens,
      requests ? Math.round(latency / requests) : 0,
      pricedRequests,
      costStatus,
      cost
    ].map(csvCell).join(',')
  })
  return `${header.join(',')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`
}
