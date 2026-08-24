import {
  normalizeWorkspaceSearchQuery,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH
} from '../lib/workspaceSearch.js'
import { searchWorkspaceHybridForUser } from '../lib/hybridWorkspaceSearch.js'
import { pool, query } from '../db/index.js'

export default async function workspaceRoutes(fastify) {
  fastify.get('/workspace/search', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAuth(request, reply)

    const rawQuery = String(request.query?.q ?? '')
    if ([...rawQuery].length > WORKSPACE_SEARCH_QUERY_MAX_LENGTH) {
      reply.code(400)
      return {
        error: `Search query must be ${WORKSPACE_SEARCH_QUERY_MAX_LENGTH} characters or fewer`
      }
    }

    const normalized = normalizeWorkspaceSearchQuery(rawQuery)
    return searchWorkspaceHybridForUser({
      userId: request.currentUser.id,
      search: normalized,
      limit: request.query?.limit,
      poolInstance: pool,
      queryFn: query,
      logger: request.log
    })
  })
}
