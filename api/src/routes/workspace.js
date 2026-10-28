import {
  normalizeWorkspaceSearchQuery,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH
} from '../lib/workspaceSearch.js'
import { searchWorkspaceHybridForUser } from '../lib/hybridWorkspaceSearch.js'
import { pool, query } from '../db/index.js'
import { searchMonitor } from '../lib/monitorWorkspace.js'

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
    const [workspace, servers] = await Promise.allSettled([searchWorkspaceHybridForUser({
      userId: request.currentUser.id,
      search: normalized,
      limit: request.query?.limit,
      poolInstance: pool,
      queryFn: query,
      logger: request.log
    }), request.currentUser.role === 'admin' ? searchMonitor(request.currentUser.id,rawQuery) : Promise.resolve([])])
    if (workspace.status === 'rejected') throw workspace.reason
    return { ...workspace.value, servers: servers.status === 'fulfilled' ? servers.value : [],
      failedSources: servers.status === 'rejected' ? ['服务器监控'] : [] }
  })
}
