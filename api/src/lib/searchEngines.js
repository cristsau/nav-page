export function normalizeEngineMonogram(value, fallback = 'S') {
  const characters = Array.from(String(value ?? '').normalize('NFKC'))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .slice(0, 2)

  return characters.length
    ? characters.join('').toLocaleUpperCase('zh-CN')
    : fallback
}

export function isValidSearchUrl(value) {
  try {
    const url = new URL(String(value || '').replaceAll('{query}', 'domo'))
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}

export function removeSearchEngineReferences(appConfig, engineId) {
  if (!appConfig || typeof appConfig !== 'object' || Array.isArray(appConfig)) {
    return appConfig
  }

  const updated = JSON.parse(JSON.stringify(appConfig))
  const search = updated.search && typeof updated.search === 'object' && !Array.isArray(updated.search)
    ? updated.search
    : {}

  updated.search = search

  if (updated.searchEngine === engineId) {
    updated.searchEngine = 'baidu'
  }

  if (Array.isArray(search.quickAccessEngineIds)) {
    search.quickAccessEngineIds = search.quickAccessEngineIds
      .filter((id) => id !== engineId)
  }

  if (
    search.aggregate
    && typeof search.aggregate === 'object'
    && !Array.isArray(search.aggregate)
    && Array.isArray(search.aggregate.engines)
  ) {
    search.aggregate.engines = search.aggregate.engines
      .filter((id) => id !== engineId)
  }

  return updated
}

export function mapCustomSearchEngine(record) {
  if (!record) return null

  return {
    id: record.id,
    name: record.name,
    icon: normalizeEngineMonogram(record.icon),
    url: record.url,
    order: record.display_order,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}
