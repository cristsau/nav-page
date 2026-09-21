import { config } from '../config.js'
import { BackupControlError, backupControlClient, cleanControlStatus, loadBackupControl } from '../lib/dropboxBackupControl.js'

const id = /^[a-f0-9]{32}$/
const messages = {
  CONTROL_UNAVAILABLE: '备份执行器未接通或状态需要检查；未确认的请求请先刷新任务记录，不要重复发起。',
  NOT_CONNECTED: '备份操作入口尚未在服务器启用。', OWNER_REQUIRED: '仅绑定的管理员本人可操作个人备份。',
  BACKUP_BUSY: '已有备份或下载正在进行，请稍后再试。', REVIEW_REQUIRED: '上一次备份结果需要核对，已暂停新的备份。',
  OPERATION_DISABLED: '此操作尚未启用或安全条件未满足。', SCHEDULE_GATE_CLOSED: '定时备份需完成最终恢复验证并由服务器开放。',
  SCHEDULE_CONFLICT: '设置已变化，请刷新后重新保存。', HISTORY_LIMIT: '近期任务记录已达上限，请稍后再试。',
  IDEMPOTENCY_CONFLICT: '请求编号冲突，请刷新任务记录。', INVALID_OPERATION: '备份操作参数无效。', RATE_LIMIT: '操作过于频繁，请稍后再试。'
}
export default async function backupControlRoutes(app, options = {}) {
  const load = options.loadConfig || (() => loadBackupControl(config.managedIntegrationsDir))
  const client = options.client || backupControlClient
  let count = 0, until = 0, downloads = 0
  const endpoint = fn => async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options', 'nosniff')
    await app.requireAdmin(request, reply)
    if (reply.sent) return
    try {
      const c = await load()
      if (!c) {
        if (request.method === 'GET' && request.routeOptions.url.endsWith('/status')) return { connected: false }
        throw new BackupControlError('NOT_CONNECTED')
      }
      if (request.currentUser.id !== c.ownerUserId) throw new BackupControlError('OWNER_REQUIRED', 403)
      if (Date.now() > until) { count = 0; until = Date.now() + 60000 }
      if (++count > 90) throw new BackupControlError('RATE_LIMIT', 429)
      return await fn(request, reply, client(c))
    } catch (e) {
      const code = e instanceof BackupControlError && messages[e.code] ? e.code : 'CONTROL_UNAVAILABLE'
      return reply.code(e instanceof BackupControlError ? e.statusCode : 503).send({ code, error: messages[code] })
    }
  }
  const root = '/admin/integrations/dropbox-backup'
  app.get(root + '/status', endpoint(async (_req, _reply, c) => cleanControlStatus(await c.status())))
  app.post(root + '/jobs', { bodyLimit: 2048 }, endpoint(async (req, reply, c) => {
    const b = req.body
    if (!b || Object.keys(b).some(k => !['id', 'kind', 'pointId'].includes(k)) || typeof b.id !== 'string' || !id.test(b.id)
      || !['backup', 'verify'].includes(b.kind) || (b.kind === 'verify' ? typeof b.pointId !== 'string' || !id.test(b.pointId) : b.pointId != null)) throw new BackupControlError('INVALID_OPERATION', 400)
    await c.enqueue(b)
    return reply.code(202).send({ accepted: true, id: b.id })
  }))
  app.put(root + '/schedule', { bodyLimit: 2048 }, endpoint(async (req, _reply, c) => {
    const b = req.body
    if (!b || Object.keys(b).sort().join(',') !== 'enabled,revision,time' || typeof b.enabled !== 'boolean'
      || typeof b.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(b.time) || !Number.isSafeInteger(b.revision) || b.revision < 0) throw new BackupControlError('INVALID_OPERATION', 400)
    await c.schedule(b); return { saved: true }
  }))
  app.get(root + '/ciphertext/:id', endpoint(async (req, reply, c) => {
    if (!id.test(req.params.id)) throw new BackupControlError('INVALID_OPERATION', 400)
    if (downloads) throw new BackupControlError('BACKUP_BUSY', 429)
    downloads++
    let stream
    try {
      const result = await c.download(req.params.id); stream = result.stream
      reply.raw.once('close', () => stream.destroy())
      let released = false
      const release = () => { if (!released) { released = true; downloads-- } }
      stream.once('close', release)
      return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', String(result.bytes))
        .header('Content-Disposition', `attachment; filename="nav-${req.params.id}.tar.age"`).send(stream)
    } catch (e) { if (!stream) downloads--; throw e }
  }))
}
