import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { DropboxFilesError, DropboxFilesService, loadFilesConnection, deny } from '../lib/dropboxFiles.js'
import { DropboxFileUploads, CHUNK_LIMIT } from '../lib/dropboxFileUploads.js'
import { loadUploadStore } from '../lib/dropboxUploadStore.js'
import { OfflineDownloads, EncryptedOfflineStore, loadOfflineConfig, connectionIdentity } from '../lib/offlineDownloads.js'

const errors = {
  UPLOAD_STORE_UNAVAILABLE: '离线上传进度存储暂不可用，已暂停操作；请联系管理员核对，不会覆盖文件。',
  OFFLINE_DISABLED: '离线下载尚未启用。', OFFLINE_QUEUE_FULL: '最多 10 个未完成任务，请先处理或清理已完成记录。',
  INVALID_DOWNLOAD_URL: '请填写 HTTP/HTTPS 文件直链；暂不支持磁力、种子、登录凭据或非标准端口。',
  OFFLINE_REVIEW_REQUIRED: '上传结果需要人工核对，不能重复提交或取消已完成文件。', OFFLINE_STATE_INVALID: '任务状态不可用，已暂停操作，请联系管理员。',
  OFFLINE_CONFIG_INVALID: '下载节点配置需要检查。', TARGET_EXISTS: '目标已存在或有同名任务，不会覆盖。',
  BACKUP_PROTECTED: '此路径涉及受保护的备份目录，已拒绝。', INVALID_DESTINATION: '请先选择已存在的文件夹。',
  OFFLINE_JOB_MISSING: '任务不存在或连接已变化。', OFFLINE_PAUSED: '任务已暂停或取消。', UPLOAD_EXPIRED: '上传会话已失效，请重新核对任务。'
}
export default async function offlineDownloadRoutes(app, options = {}) {
  const loadConfig = options.loadConfig || (() => loadOfflineConfig(config.managedIntegrationsDir))
  const loadConnection = options.loadConnection || (() => loadFilesConnection(config.managedIntegrationsDir))
  const openStore = options.loadUploadStore || (() => loadUploadStore(config.managedIntegrationsDir, 'offline'))
  let cached, cachedId = '', active = 0, bodies = 0, requests = 0, window = 0
  let initializing = Promise.resolve()
  app.addHook('onClose', async () => { await initializing.catch(() => {}); await cached?.uploads?.store?.close() })
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_LIMIT }, (_req, body, done) => done(null, body))
  const root = '/offline-downloads'
  async function context(request, worker) {
    if (!worker) await app.requireAdmin(request, request.offlineReply)
    const settings = await loadConfig()
    if (!settings) deny('OFFLINE_DISABLED', 503)
    if (worker) {
      const value = request.headers.authorization
      if (request.headers.origin || typeof value !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(value)
        || !timingSafeEqual(Buffer.from(value), Buffer.from('Bearer ' + settings.workerKey))) deny('OWNER_REQUIRED', 403)
    }
    const connection = await loadConnection()
    if (!connection || (!worker && request.currentUser.id !== connection.ownerUserId)) deny('OWNER_REQUIRED', 403)
    const id = connectionIdentity({ connection, settings })
    const ready = initializing.then(async () => {
      if (id === cachedId) return cached
      if (active) deny('BUSY', 429)
      await cached?.uploads?.store?.close(); cachedId = ''
      const service = options.createService ? options.createService(connection) : new DropboxFilesService(connection)
      cached = options.createManager ? await options.createManager(service) : new OfflineDownloads({ service,
        uploads: await DropboxFileUploads.restore(service, await openStore(), id),
        store: new EncryptedOfflineStore(config.managedIntegrationsDir, settings.workerKey), identity: connectionIdentity(connection), maxBytes: settings.maxBytes })
      cachedId = id
      return cached
    })
    initializing = ready.then(() => {}, () => {})
    return ready
  }
  function endpoint(worker, fn) {
    return async (req, reply) => {
      let slot = false
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer')
      try {
        if (Date.now() > window) { window = Date.now() + 60000; requests = 0 }
        if (++requests > 600 || active >= 3) deny('BUSY', 429)
        req.offlineReply = reply
        const manager = await context(req, worker)
        if (active >= 3) deny('BUSY', 429)
        active++; slot = true
        return await fn(manager, req)
      } catch (error) {
        const code = error instanceof DropboxFilesError ? error.code : 'OFFLINE_UNAVAILABLE'
        const status = error instanceof DropboxFilesError ? error.statusCode : reply.statusCode >= 400 ? reply.statusCode : 503
        return reply.code(status).send({ code, error: errors[code] || (status === 401 ? '请先登录。' : '任务未完成，请刷新核对；不会自动覆盖或删除文件。') })
      } finally { if (slot) active-- }
    }
  }
  async function reserve(req, reply) {
    if (bodies >= 1) return reply.code(429).send({ code: 'BUSY' })
    bodies++; let released = false
    const release = () => { if (!released) { released = true; bodies--; reply.raw.off('close', release); reply.raw.off('finish', release); req.raw.off('aborted', release) } }
    reply.raw.once('close', release); reply.raw.once('finish', release); req.raw.once('aborted', release)
  }
  app.get(root + '/status', endpoint(false, manager => manager.status()))
  app.post(root + '/add', { bodyLimit: 16384 }, endpoint(false, (manager, req) => manager.add(req.body || {})))
  app.post(root + '/control', { bodyLimit: 4096 }, endpoint(false, (manager, req) => manager.control(req.body?.id, req.body?.command)))
  app.post(root + '/clear', { bodyLimit: 4096 }, endpoint(false, manager => manager.clear()))
  app.post(root + '/worker/claim', { bodyLimit: 4096 }, endpoint(true, manager => manager.claim()))
  app.post(root + '/worker/progress', { bodyLimit: 4096 }, endpoint(true, (manager, req) => manager.progress(req.body?.id, req.body || {})))
  for (const operation of ['start', 'finish']) app.post(root + '/worker/' + operation, { bodyLimit: 4096 }, endpoint(true, (manager, req) => manager.transfer(req.body?.id, operation, req.body || {})))
  app.post(root + '/worker/chunk', { bodyLimit: CHUNK_LIMIT, onRequest: reserve }, endpoint(true, (manager, req) => {
    const offset = req.headers['x-upload-offset'], id = req.headers['x-offline-job']
    if (typeof offset !== 'string' || !/^\d{1,12}$/.test(offset) || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !Buffer.isBuffer(req.body)) deny('INVALID_CHUNK')
    return manager.transfer(id, 'chunk', { offset: Number(offset) }, req.body)
  }))
}
