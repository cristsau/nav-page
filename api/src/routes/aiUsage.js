import {
  buildAiUsageCsv,
  loadAiUsageSummary,
  normalizeAiUsageRange,
  SELECT_AI_USAGE_SQL
} from '../lib/aiUsage.js'
import { query } from '../db/index.js'

export default async function aiUsageRoutes(fastify) {
  fastify.get('/ai-usage', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAuth(request, reply)

    return loadAiUsageSummary({
      userId: request.currentUser.id,
      days: request.query?.days,
      queryFn: query
    })
  })

  fastify.get('/ai-usage.csv', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAuth(request, reply)

    const days = normalizeAiUsageRange(request.query?.days)
    const { rows } = await query(SELECT_AI_USAGE_SQL, [
      request.currentUser.id,
      days
    ])
    const filename = `domo-nav-ai-usage-${days}d-${new Date().toISOString().slice(0, 10)}.csv`

    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.type('text/csv; charset=utf-8')
    return `\uFEFF${buildAiUsageCsv(rows)}`
  })
}
