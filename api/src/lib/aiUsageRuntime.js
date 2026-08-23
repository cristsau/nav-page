import { config } from '../config.js'
import { query } from '../db/index.js'
import {
  parseAiPriceCatalog,
  recordAiUsageSafely
} from './aiUsage.js'

export function recordRuntimeAiUsageSafely(payload, logger) {
  return recordAiUsageSafely({
    ...payload,
    queryFn: query,
    priceCatalog: parseAiPriceCatalog(config.aiPriceCatalogJson)
  }, logger)
}
