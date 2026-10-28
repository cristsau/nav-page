import { Readable } from 'node:stream'
import { config } from '../config.js'
import { MonitorBridge, loadMonitorConfig, monitorError, monitorJson } from '../lib/monitorBridge.js'
import { registerMonitorWorkspace } from './monitorWorkspace.js'

const messages = {
  MONITOR_FIELDS_INVALID:'字段不正确，请检查后重试。', MONITOR_DATE_INVALID:'日期必须明确到年、月、日，且真实有效。',
  MONITOR_NODE_INVALID:'未找到这台服务器。', MONITOR_LINK_INVALID:'链接只接受不带密码、查询参数的 HTTP/HTTPS 地址。',
  MONITOR_CHANGE_CONFLICT:'资料已被修改，请刷新并重新核对；本次未覆盖。',
  MONITOR_CHANGE_REVIEW:'写入结果需要核对，请在维护记录中检查。不要重复提交。',
  MONITOR_CHANGE_MISSING:'未找到这次修改。',MONITOR_IMAGE_INVALID:'请选择 3 MB 以内的 PNG、JPEG 或 WebP 图片。',
  MONITOR_AI_INVALID:'AI 返回的资料未通过校验，请手动核对。',MONITOR_AI_UNAVAILABLE:'AI 暂不可用或不支持此图片，请检查模型配置或手动填写。',
  MONITOR_DISABLED: '服务器监控尚未接入。', MONITOR_CONFIG_INVALID: '监控连接配置需要检查。',
  MONITOR_LOGIN_UNAVAILABLE: '监控连接登录失效，请维护服务器端的连接凭据。',
  MONITOR_UNAVAILABLE: '暂时无法连接监控服务，请稍后重试。',
  MONITOR_NAV_AUTH_MANAGED: '登录由 NAV 管理，应急密码需与连接配置一起维护。',
  MONITOR_PATH_INVALID: '此操作不能从 NAV 监控入口执行。'
}
export default async function monitorRoutes(app, options = {}) {
  const load = options.loadConfig || (() => loadMonitorConfig(config.managedIntegrationsDir))
  let cached, active = 0
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body))
  async function context(req, reply) {
    await app.requireAdmin(req, reply)
    const settings = await load()
    if (!settings) throw monitorError('MONITOR_DISABLED')
    if (settings.ownerUserId !== req.currentUser.id) throw monitorError('OWNER_REQUIRED', 403)
    if (!cached || JSON.stringify(cached.settings) !== JSON.stringify(settings)) cached = new MonitorBridge(settings, options.fetcher)
    return cached
  }
  const handler = fn => async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer')
    let reserved = false
    try {
      const bridge = await context(req, reply)
      if (active >= 4) throw monitorError('MONITOR_BUSY', 429)
      active++; reserved = true
      return await fn(bridge, req, reply)
    } catch (error) {
      const status = reply.statusCode >= 400 ? reply.statusCode : (Number.isInteger(error.statusCode) ? error.statusCode : 503)
      const code = Object.hasOwn(messages, error.code || '') ? error.code : 'MONITOR_UNAVAILABLE'
      return reply.code(status).send({ code, error: status === 401 ? '请先登录 NAV。' : status === 403 ? '仅限绑定的管理员访问。' : messages[code] })
    } finally { if (reserved) active-- }
  }
  app.get('/monitor/status', handler(async bridge => {
    const response = await bridge.request('/me')
    if (!response.ok) { await response.body?.cancel(); throw monitorError('MONITOR_UNAVAILABLE') }
    if ((await monitorJson(response)).authed !== true) throw monitorError('MONITOR_LOGIN_UNAVAILABLE')
    return { enabled: true, connected: true, path: '/monitor-app/', login: 'nav', refreshSeconds: 5 }
  }))
  await registerMonitorWorkspace(app,handler)
  app.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], url: '/monitor/proxy/*', bodyLimit: 8 * 1024 * 1024,
    handler: handler(async (bridge, req, reply) => {
      const raw = req.raw.url, marker = '/monitor/proxy/', index = raw.indexOf(marker)
      const path = '/' + raw.slice(index + marker.length)
      const type = String(req.headers['content-type'] || '').split(';', 1)[0]
      if (req.body !== undefined && !['application/json', 'application/octet-stream'].includes(type)) throw monitorError('MONITOR_BODY_INVALID', 400)
      const abort = new AbortController()
      const stop = () => { if (!reply.raw.writableEnded) abort.abort() }
      reply.raw.once('close', stop)
      const body = req.body === undefined ? undefined : Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body)
      let response
      try { response = await bridge.request(path, { method: req.method, body, contentType: type, signal: abort.signal }) }
      catch (error) { reply.raw.off('close', stop); throw error }
      reply.code(response.status)
      for (const name of ['content-type', 'content-disposition']) { const value = response.headers.get(name); if (value) reply.header(name, value) }
      // Never forward cookies, Location, auth headers or upstream cache policy.
      if (!response.body || req.method === 'HEAD') { reply.raw.off('close', stop); await response.body?.cancel(); return reply.send() }
      return reply.send(Readable.fromWeb(response.body))
    })
  })
}
