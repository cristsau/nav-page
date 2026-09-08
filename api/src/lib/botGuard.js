import { config } from '../config.js'
import { query } from '../db/index.js'
import { consumePersistentRateLimit } from './persistentRateLimit.js'

const HOSTS = new Set(['nav.skrskr.net', 'nav.cristsau.cn'])
const ACTIONS = new Set(['password_login','register','register_resend','email_login','password_reset','account_recovery'])
export const turnstileTokenSchema = { type: 'string', minLength: 1, maxLength: 2048 }
export class BotGuardError extends Error {
  constructor(code = 'BOT_CHALLENGE_REQUIRED', statusCode = 403) {
    super(statusCode === 503 ? '安全验证暂不可用，请稍后重试。' : '请先完成安全验证，再提交。')
    this.code = code
    this.statusCode = statusCode
  }
}
export function botGuardPublicConfig(runtime = config) {
  return { enabled: runtime.turnstileEnabled === true,
    siteKey: runtime.turnstileEnabled && runtime.turnstileSecretKey ? runtime.turnstileSiteKey : '',
    passwordMode: 'after_three_attempts', provider: 'cloudflare-turnstile' }
}
export function createBotGuard({ runtime = config, fetchFn = (...args) => fetch(...args),
  consume = consumePersistentRateLimit, queryFn = query, now = Date.now } = {}) {
  return async function enforceBotGuard(request, action) {
    if (!runtime.turnstileEnabled) return
    if (!ACTIONS.has(action) || !runtime.turnstileSiteKey || !runtime.turnstileSecretKey) throw new BotGuardError('BOT_GUARD_UNAVAILABLE',503)
    const hostname = request.hostname
    if (!HOSTS.has(hostname) || request.headers.origin !== `https://${hostname}`) throw new BotGuardError('BOT_ORIGIN_INVALID')
    const token = request.body?.turnstileToken
    if (action === 'password_login') {
      // Independent, persistent per-IP attempt counter; a browser cannot clear it.
      // Shared IPs may see a challenge after three attempts, but never an account lockout.
      let rate
      try { rate = await consume(request.ip,{scope:'password_bot_risk',limit:3,windowMs:600000,queryFn}) }
      catch { throw new BotGuardError('BOT_GUARD_UNAVAILABLE',503) }
      if (rate.allowed && !token) return
    }
    if (typeof token !== 'string' || !token.length || token.length > 2048) throw new BotGuardError()
    let result
    try {
      const response = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(6000),
        headers:{'Content-Type':'application/json'},
        // Do not send account identifiers, passwords or email addresses to Cloudflare.
        body:JSON.stringify({secret:runtime.turnstileSecretKey,response:token})
      })
      if (!response.ok) throw new Error('unavailable')
      result = await response.json()
    } catch { throw new BotGuardError('BOT_GUARD_UNAVAILABLE',503) }
    const age = now() - Date.parse(result.challenge_ts)
    if (result.success !== true || result.hostname !== hostname || result.action !== action || !Number.isFinite(age) || age < -30000 || age > 300000) {
      throw new BotGuardError('BOT_CHALLENGE_INVALID')
    }
    // Siteverify consumes each token once; a timeout is never retried or bypassed.
  }
}
export const enforceBotGuard = createBotGuard()
