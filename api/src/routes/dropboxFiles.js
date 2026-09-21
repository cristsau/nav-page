import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { config } from '../config.js'
import { DropboxFilesError, DropboxFilesService, loadFilesConnection, filePath, contentType, UPLOAD_LIMIT } from '../lib/dropboxFiles.js'
import { DropboxFileUploads, CHUNK_LIMIT, LARGE_UPLOAD_LIMIT } from '../lib/dropboxFileUploads.js'
import { loadUploadStore } from '../lib/dropboxUploadStore.js'
import { listFileHistory, fileRevision, recoverRevisionCopy } from '../lib/dropboxFileHistory.js'
import { listDeletedFiles, deletedHistory, deletedRevision, recoverDeletedCopy } from '../lib/dropboxDeletedFiles.js'

const messages = {
  UPLOAD_STORE_UNAVAILABLE: '上传进度存储暂不可用，已停止上传；请检查服务器配置，不会重新覆盖文件。',
  UPLOAD_FILE_MISMATCH: '文件内容与原任务不一致，已停止续传；请选择原文件。',
  DELETED_FILE_CHANGED: '此记录已变化或不是可找回的文件，请刷新，或在 Dropbox 官方回收站处理。',
  REVISION_UNAVAILABLE: '该版本已不可用，请重新读取历史记录或在 Dropbox 官方页面查看。',
  REVISION_COPY_TOO_LARGE: '内置版本另存上限为 20 MB。大文件请下载历史版本，或在 Dropbox 官方页面恢复。',
  NOT_CONNECTED: '文件库尚未连接。请先完成独立 Full Dropbox 应用授权。',
  OWNER_REQUIRED: '此文件库仅限绑定的管理员本人使用。',
  BACKUP_PROTECTED: '此操作涉及受保护的备份目录，已阻止。',
  BACKUP_PROTECTION_UNAVAILABLE: '无法确认备份目录保护状态，已暂停文件操作。',
  FILE_CHANGED: '文件已在其他位置修改，请重新读取后再保存。',
  PROVIDER_CONFLICT: '文件不存在或发生冲突。请刷新列表，不要重复提交。',
  INVALID_JSON: 'JSON 格式不正确，请修正后再保存。',
  TEXT_ENCODING_UNSUPPORTED: '仅支持 UTF-8 文本，请下载后编辑此文件。',
  TEXT_UNSUPPORTED: '此文件不支持内置文本编辑，或超过 1 MB。',
  FOLDER_DELETE_DISABLED: '暂不支持删除文件夹，防止递归误删。请在 Dropbox 官方页面处理。',
  INVALID_CONNECTION: '文件库连接配置需要检查。',
  CURSOR_EXPIRED: '列表已过期，请重新刷新。',
  BUSY: '当前操作较多，请稍后再试。',
  UPLOAD_TOO_LARGE: '分块上传单文件上限为 50 GB，旧版直接上传上限为 20 MB。',
  FOLDER_TOO_LARGE: '此文件夹超过本次安全核对上限（500 个子项），请拆分操作或在 Dropbox 官方页面处理。',
  DELETE_EXPIRED: '删除确认已过期，请重新选择并确认。',
  DELETE_REVIEW_REQUIRED: '此删除已提交或结果待核对，请刷新列表，不要重复删除。',
  UPLOAD_EXPIRED: '上传会话已过期或服务器已重启，请重新选择文件。',
  UPLOAD_REVIEW_REQUIRED: '上传提交结果需要核对，请刷新目录检查，勿重复上传或删除同名文件。',
  INVALID_CHUNK: '上传分块不匹配，请暂停后重试。',
  UPLOAD_OFFSET_MISMATCH: '上传进度校验不一致，已停止提交。',
  UPLOAD_RECEIPT_INVALID: '上传回执校验未通过，请核对 Dropbox 文件，勿重复提交。',
  UPLOAD_INCOMPLETE: '文件尚未传完，不能提交。',
  TARGET_EXISTS: '目标目录已有同名项目，请先改名或选择其他目录，不会覆盖原文件。',
}
export default async function dropboxFileRoutes(app, options = {}) {
  const load = options.loadConnection || (() => loadFilesConnection(config.managedIntegrationsDir))
  const create = options.createService || (connection => new DropboxFilesService(connection))
  const openStore = options.loadUploadStore || (() => loadUploadStore(config.managedIntegrationsDir))
  let cached = null, uploads = null, fingerprint = '', active = 0, streams = 0, bufferedBodies = 0
  let initializing = Promise.resolve()
  app.addHook('onClose', async () => { await initializing.catch(() => {}); await uploads?.store?.close() })
  const cursors = new Map(), budgets = new Map()
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_LIMIT }, (_req, body, done) => done(null, body))
  async function reserveBody(request, reply) {
    // Before parsing: auth runs in the shared preHandler, so cap even unauthenticated buffers.
    if (bufferedBodies >= 2) return reply.code(429).header('Cache-Control', 'no-store').send({ code: 'BUSY', error: messages.BUSY })
    bufferedBodies++
    let released = false
    const release = () => {
      if (released) return
      released = true; bufferedBodies--
      reply.raw.off('close', release); reply.raw.off('finish', release); request.raw.off('aborted', release)
    }
    reply.raw.once('close', release); reply.raw.once('finish', release); request.raw.once('aborted', release)
  }
  function cursorToken(value, owner, path, query, purpose = 'list') {
    const now = Date.now()
    for (const [key, item] of cursors) if (item.until < now) cursors.delete(key)
    if (cursors.size >= 200) cursors.delete(cursors.keys().next().value)
    const key = randomBytes(24).toString('hex')
    cursors.set(key, { value, owner, path, query, purpose, until: now + 300000 })
    return key
  }
  function takeCursor(key, owner, path, query, purpose = 'list') {
    if (!key) return null
    const item = cursors.get(key)
    if (!item || item.until < Date.now() || item.owner !== owner || item.path !== path || item.query !== query || item.purpose !== purpose) throw new DropboxFilesError('CURSOR_EXPIRED', 409)
    return item.value
  }
  async function context(request, reply) {
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
    await app.requireAdmin(request, reply)
    const connection = await load()
    if (!connection) throw new DropboxFilesError('NOT_CONNECTED', 503)
    if (request.currentUser.id !== connection.ownerUserId) throw new DropboxFilesError('OWNER_REQUIRED', 403)
    const chunk = request.routeOptions.url.endsWith('/upload/chunk')
    const now = Date.now(), id = request.currentUser.id + (chunk ? ':chunks' : ':operations')
    for (const [key, b] of budgets) if (b.until < now) budgets.delete(key)
    const budget = budgets.get(id) || { count: 0, until: now + 60000 }
    if (++budget.count > (chunk ? 600 : 120) || active >= 4) throw new DropboxFilesError('BUSY', 429)
    budgets.set(id, budget)
    const next = createHash('sha256').update(JSON.stringify(connection)).digest('hex')
    const ready = initializing.then(async () => {
      if (next === fingerprint) return { service: cached, manager: uploads }
      if (active) throw new DropboxFilesError('BUSY', 429)
      await uploads?.store?.close(); fingerprint = ''
      const service = create(connection)
      const manager = await DropboxFileUploads.restore(service, await openStore(), next)
      cached = service; uploads = manager; fingerprint = next; cursors.clear()
      return { service, manager }
    })
    initializing = ready.then(() => {}, () => {})
    return ready
  }
  function endpoint(handler) {
    return async (request, reply) => {
      let acquired = false
      try {
        const { service, manager } = await context(request, reply)
        if (active >= 4) throw new DropboxFilesError('BUSY', 429)
        active++; acquired = true
        return await handler(request, reply, service, manager)
      } catch (error) {
        if (!(error instanceof DropboxFilesError)) {
          // Preserve auth status but never reflect/log provider errors or file contents.
          return reply.code(reply.statusCode >= 400 ? reply.statusCode : 502).send({ code: 'FILES_UNAVAILABLE', error: reply.statusCode === 401 ? '请先登录。' : '文件操作未完成，请刷新核对状态。' })
        }
        return reply.code(error.statusCode).send({ code: error.code, error: messages[error.code] || '文件操作未完成，请检查输入或稍后重试。' })
      } finally { if (acquired) active-- }
    }
  }
  const root = '/dropbox-files'
  app.get(root + '/status', endpoint(async (_request, _reply, _service, manager) => ({ connected: true, scope: 'full_dropbox', ownerOnly: true,
    uploadLimit: LARGE_UPLOAD_LIMIT, chunkSize: CHUNK_LIMIT, uploadResume: manager.store ? 'reselect_after_restart_encrypted' : 'reselect_after_refresh_api_process', deletedFiles: true, batchLimit: 50,
    textLimit: 1024 * 1024, backupProtection: 'checked_on_each_operation' })))
  app.post(root + '/list', { bodyLimit: 32768 }, endpoint(async (request, _reply, service) => {
    const path = filePath(request.body?.path || '', true), query = request.body?.query || ''
    const cursor = takeCursor(request.body?.cursor, request.currentUser.id, path, query)
    const result = await service.list({ path, query, cursor })
    return { entries: result.entries, hasMore: result.hasMore,
      cursor: result.cursor ? cursorToken(result.cursor, request.currentUser.id, path, query) : null }
  }))
  app.post(root + '/deleted/list', { bodyLimit: 8192 }, endpoint(async (request, _reply, service) => {
    const path = filePath(request.body?.path || '', true)
    const result = await listDeletedFiles(service, path, takeCursor(request.body?.cursor, request.currentUser.id, path, '', 'deleted-list'))
    return { entries: result.entries, hasMore: result.hasMore, cursor: result.hasMore ? cursorToken(result.cursor, request.currentUser.id, path, '', 'deleted-list') : null }
  }))
  app.post(root + '/deleted/history', { bodyLimit: 8192 }, endpoint(async (request, _reply, service) => {
    const history = await deletedHistory(service, request.body?.path)
    return { ...history, entries: history.entries.map(item => ({ ...item,
      downloadToken: cursorToken({ path: history.deleted.path, rev: item.rev, id: item.id }, request.currentUser.id, '', '', 'deleted-download') })) }
  }))
  app.post(root + '/deleted/copy', { bodyLimit: 8192, onRequest: reserveBody }, endpoint(async (request, _reply, service) => ({
    item: await recoverDeletedCopy(service, request.body?.path, request.body?.rev, request.body?.destination)
  })))
  app.post(root + '/folder', endpoint(async (request, _reply, service) => ({ item: await service.mkdir(request.body?.path) })))
  app.post(root + '/history', endpoint(async (request, _reply, service) => listFileHistory(service, request.body?.id)))
  app.post(root + '/history/copy', { bodyLimit: 8192, onRequest: reserveBody }, endpoint(async (request, _reply, service) => ({ item: await recoverRevisionCopy(service, request.body?.id, request.body?.rev, request.body?.destination) })))
  app.post(root + '/move', endpoint(async (request, _reply, service) => ({ item: await service.move(request.body?.id, request.body?.destination) })))
  app.post(root + '/copy', endpoint(async (request, _reply, service) => ({ item: await service.copy(request.body?.id, request.body?.destination) })))
  app.post(root + '/delete/preview', endpoint(async (request, _reply, service) => service.prepareDelete(request.body?.id)))
  app.post(root + '/delete', endpoint(async (request, _reply, service) => request.body?.token
    ? service.deleteConfirmed(request.body?.id, request.body.token)
    : service.remove(request.body?.id, request.body?.rev, request.body?.confirmation)))
  app.post(root + '/upload/list', { bodyLimit: 8192 }, endpoint(async (_q, _r, _s, u) => u.list()))
  app.post(root + '/upload/reattach', { bodyLimit: 8192 }, endpoint(async (request, _r, _s, u) => u.reattach(request.body?.uploadId, request.body?.size, request.body?.contentHash)))
  app.post(root + '/upload/start', { bodyLimit: 8192 }, endpoint(async (request, _r, _s, u) => u.start(request.body?.path, request.body?.size, request.body?.contentHash ?? null)))
  app.post(root + '/upload/status', endpoint(async (request, _r, _s, u) => u.status(request.body?.uploadId)))
  app.post(root + '/upload/chunk', { bodyLimit: CHUNK_LIMIT, onRequest: reserveBody }, endpoint(async (request, _r, _s, u) => {
    const offset = request.headers['x-upload-offset']
    if (typeof offset !== 'string' || !/^\d{1,12}$/.test(offset)) throw new DropboxFilesError('INVALID_CHUNK')
    return u.append(request.headers['x-upload-id'], Number(offset), request.body)
  }))
  app.post(root + '/upload/finish', endpoint(async (request, _r, _s, u) => u.finish(request.body?.uploadId)))
  app.post(root + '/upload/cancel', endpoint(async (request, _r, _s, u) => u.cancel(request.body?.uploadId)))
  app.post(root + '/text/read', endpoint(async (request, _reply, service) => service.text(request.body?.id)))
  app.post(root + '/text/save', { bodyLimit: 7 * 1024 * 1024, onRequest: reserveBody }, endpoint(async (request, _reply, service) => ({ item: await service.save(request.body?.id, request.body?.rev, request.body?.content) })))
  app.post(root + '/upload', { bodyLimit: UPLOAD_LIMIT, onRequest: reserveBody }, endpoint(async (request, _reply, service) => {
    if (!Buffer.isBuffer(request.body)) throw new DropboxFilesError('INVALID_UPLOAD')
    let path
    try { path = decodeURIComponent(request.headers['x-file-name'] || '') } catch { throw new DropboxFilesError('INVALID_PATH') }
    return { item: await service.upload(path, request.body) }
  }))
  const streamContent = endpoint(async (request, reply, service) => {
    if (streams >= 2) throw new DropboxFilesError('BUSY', 429)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60 * 60 * 1000)
    streams++
    let done = false
    const release = () => { if (!done) { done = true; streams--; clearTimeout(timer); controller.abort() } }
    reply.raw.once('close', release)
    try {
      let item
      if (request.params.token) {
        const reference = takeCursor(request.params.token, request.currentUser.id, '', '', 'deleted-download')
        if (!reference) throw new DropboxFilesError('CURSOR_EXPIRED', 409)
        item = await deletedRevision(service, reference.path, reference.rev)
        if (item.id !== reference.id) throw new DropboxFilesError('DELETED_FILE_CHANGED', 409)
      } else item = request.query?.rev ? (await fileRevision(service, request.params.id, request.query.rev)).item : await service.get(request.params.id)
      if (item.type !== 'file' || !item.downloadable) throw new DropboxFilesError('FILE_UNAVAILABLE', 415)
      const inline = !request.params.token && request.query?.inline === '1' && ['image', 'video', 'audio', 'pdf'].includes(item.kind)
      const response = await service.client.download(item, { range: request.headers.range, signal: controller.signal })
      reply.code(response.status).type(inline ? contentType(item.name) : 'application/octet-stream')
      reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'self'")
      reply.header('Accept-Ranges', 'bytes')
      const length = response.headers.get('content-length'), range = response.headers.get('content-range')
      if (length && /^\d+$/.test(length)) reply.header('Content-Length', length)
      if (response.status === 206) {
        if (!range || !/^bytes \d+-\d+\/\d+$/.test(range)) { await response.body.cancel(); throw new DropboxFilesError('INVALID_RANGE', 502) }
        reply.header('Content-Range', range)
      }
      // Never forward upstream transport errors into Fastify's error logger.
      const stream = Readable.from((async function* () {
        const reader = response.body.getReader()
        try {
          while (true) { const part = await reader.read(); if (part.done) break; yield part.value }
        } catch { throw new Error('FILE_STREAM_INTERRUPTED') }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      })())
      stream.on('error', () => { release(); if (!reply.raw.destroyed) reply.raw.destroy() })
      stream.once('end', release); stream.once('close', release)
      return reply.send(stream)
    } catch (error) { release(); throw error }
  })
  app.get(root + '/content/:id', streamContent)
  app.get(root + '/deleted/content/:token', streamContent)
}
