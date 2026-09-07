import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../config.js'
import { pool, withTransaction } from '../db/index.js'
import { consumePersistentRateLimit } from './persistentRateLimit.js'
import { normalizeEmailAddress, verifiedMailConfigurationStatus } from './mailOutbox.js'
import { createSessionToken, hashSessionToken, hashPassword, validateNewPassword, verifyPassword } from './auth.js'
import { recordSecurityEvent } from './securityEvents.js'
import { sanitizeUser } from './users.js'
import { isReleaseAcceptanceUsername } from '../ops/releaseAcceptanceAccount.js'
import { loadAuthEmailKeys, authEmailKeyVersion, authEmailJobContext, proofDigest, emailKeyDigest, emailCodeMac, equalDigest, newEmailCode, encryptAuthPayload, decryptAuthPayload } from './authEmailCrypto.js'

export const AUTH_EMAIL_PURPOSES = Object.freeze({
  login: 'auth.email.login', password_reset: 'auth.password.reset',
  password_change: 'auth.password.change.verify', email_bind: 'auth.email.bind', email_change: 'auth.email.change.verify'
})
export const AUTH_EMAIL_GENERIC_REPLY = '如果该邮箱可用于此操作，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。'
const PURPOSE_LABELS = { login:'登录', password_reset:'重设密码', password_change:'修改密码', email_bind:'绑定邮箱', email_change:'更换邮箱' }
const cookieOptions = () => ({ httpOnly:true, secure:config.sessionCookieSecure || process.env.NODE_ENV==='production', sameSite:'strict', path:'/api/auth', maxAge:600 })

export class AuthEmailError extends Error {
  constructor(code, statusCode=400) { super(code); this.code=code; this.statusCode=statusCode }
}
export function authEmailOrigin(request) {
  const value = String(request.headers.origin || '')
  const allowed = String(config.corsOrigin || '').split(',').map(s=>s.trim())
  if (!allowed.includes(value) || !/^https?:\/\//.test(value)) throw new AuthEmailError('AUTH_EMAIL_ORIGIN_REJECTED',403)
  return value
}
export function authEmailFlow(request, reply, purpose, create=false) {
  const name=`nav_email_${purpose}`
  let value=request.cookies?.[name]
  if (!/^[A-Za-z0-9_-]{43}$/.test(value || '')) {
    if (!create) return ''
    value=randomBytes(32).toString('base64url')
  }
  if (create) reply.setCookie(name,value,cookieOptions())
  return proofDigest(value)
}

export async function authEmailReadiness(runtime=config) {
  if (!runtime.emailLoginEnabled && !runtime.emailPasswordResetEnabled) return {emailLogin:false,emailPasswordReset:false,emailBinding:false}
  try {
    await loadAuthEmailKeys(runtime)
    const smtp=await verifiedMailConfigurationStatus(runtime)
    const ready=smtp.enabled && smtp.configured
    return {emailLogin:ready && runtime.emailLoginEnabled,emailPasswordReset:ready && runtime.emailPasswordResetEnabled,emailBinding:Boolean(ready)}
  } catch { return {emailLogin:false,emailPasswordReset:false,emailBinding:false} }
}
export async function requireEmailCapability(purpose) {
  const state=await authEmailReadiness()
  if (!(purpose==='login'?state.emailLogin:['password_change','password_reset'].includes(purpose)?state.emailPasswordReset:state.emailBinding)) {
    throw new AuthEmailError('AUTH_EMAIL_UNAVAILABLE',503)
  }
}

export async function emailRateLimit(request, scope, limit, windowMs, key=request.ip || 'unknown') {
  return consumePersistentRateLimit(key,{scope:`email_${scope}`,limit,windowMs,queryFn:pool.query.bind(pool),cleanupEvery:256})
}
export async function enforceEmailIpLimit(request, operation) {
  const result=await emailRateLimit(request,operation==='verify'?'verify_ip':'request_ip',operation==='verify'?20:10,600000)
  if(!result.allowed) { const e=new AuthEmailError('AUTH_EMAIL_RATE_LIMITED',429); e.retryAfter=result.retryAfterSeconds; throw e }
}

export async function enqueueAuthNotice(client, {userId,recipient,type,dedupeKey,text}, keys) {
  const id=randomUUID()
  await client.query(`INSERT INTO auth_email_delivery_jobs
    (id,user_id,message_type,dedupe_key,encrypted_payload,key_version,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '1 hour') ON CONFLICT(dedupe_key) DO NOTHING`,
  [id,userId,type,dedupeKey,encryptAuthPayload({recipient,subject:'DOMO NAV · 账号安全通知',text},authEmailJobContext({id,message_type:type}),keys),keys.version])
}

export async function issueEmailChallenge({request,reply,purpose,email,userId=null,grantId=null}) {
  const started=performance.now()
  async function genericResponse(id) {
    // Uniform SQL path below is the primary defense; a response floor avoids fast-limit branches.
    await delay(Math.max(0,100-(performance.now()-started)))
    return {challengeId:id,expiresIn:300,resendAfter:60,message:AUTH_EMAIL_GENERIC_REPLY}
  }
  await requireEmailCapability(purpose)
  const keys=await loadAuthEmailKeys()
  const origin=authEmailOrigin(request)
  const normalized=normalizeEmailAddress(email)
  const digest=emailKeyDigest(normalized,keys)
  const flow=authEmailFlow(request,reply,purpose,true)
  const limits=await Promise.all([
    emailRateLimit(request,'identity_hour',5,3600000,normalized),
    emailRateLimit(request,'identity_day',10,86400000,normalized),
    emailRateLimit(request,'ip_hour',50,3600000),
    emailRateLimit(request,'global_hour',200,3600000,'all'),
    emailRateLimit(request,'resend',1,60000,`${purpose}:${flow}`)
  ])
  const id=randomUUID()
  if(limits.some(r=>!r.allowed)) return genericResponse(id)
  await withTransaction(async client=>{
    const {rows}=await client.query(userId?'SELECT * FROM users WHERE id=$1 FOR UPDATE':'SELECT * FROM users WHERE LOWER(email)=$1 FOR UPDATE',[userId || normalized])
    const user=rows[0]
    let eligible=Boolean(user && user.status==='approved' && !isReleaseAcceptanceUsername(user.username)
      && (purpose==='email_bind' || (user.email_verified_at && normalizeEmailAddress(user.email)===normalized)))
    const active=await client.query(`SELECT COUNT(*)::int AS count FROM auth_email_challenges
      WHERE user_id=$1 AND purpose=$2 AND flow_digest<>$3 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>NOW()`,[eligible?user.id:null,purpose,flow])
    if(active.rows[0].count>=3)eligible=false
      if(eligible && grantId) {
        const g=await client.query(`SELECT id FROM auth_reauth_grants WHERE id=$1 AND user_id=$2 AND expires_at>NOW() AND credential_version=$3 FOR UPDATE`,[grantId,user.id,user.auth_version])
        if(!g.rowCount) throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
      }
      await client.query(`UPDATE auth_email_challenges SET revoked_at=NOW()
        WHERE user_id=$1 AND purpose=$2 AND flow_digest=$3 AND consumed_at IS NULL AND revoked_at IS NULL`,[eligible?user.id:null,purpose,flow])
    const challenge={id,user_id:eligible?user.id:null,purpose,email_key_digest:digest,origin,flow_digest:flow}
    const code=newEmailCode()
    await client.query(`INSERT INTO auth_email_challenges
      (id,user_id,purpose,email_key_digest,email_ciphertext,origin,flow_digest,code_mac,key_version,credential_version,grant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id,challenge.user_id,purpose,digest,encryptAuthPayload({email:normalized},`email:${id}`,keys),origin,flow,emailCodeMac(challenge,code,keys),keys.version,eligible?user.auth_version:0,eligible?grantId:null])
    const jobId=randomUUID()
    const label=PURPOSE_LABELS[purpose]
    const payload={recipient:normalized,subject:`DOMO NAV · ${label}验证码`,text:`您正在${label}。验证码：${code}\n有效期5分钟。发起站点：${origin}\n请勿将验证码转告他人。如果不是您本人操作，请忽略此邮件。`}
    await client.query(`INSERT INTO auth_email_delivery_jobs
      (id,challenge_id,user_id,message_type,dedupe_key,encrypted_payload,key_version,expires_at)
      SELECT $1,id,user_id,$2,$3,$4,$5,expires_at FROM auth_email_challenges WHERE id=$6 AND user_id IS NOT NULL`,
    [jobId,AUTH_EMAIL_PURPOSES[purpose],`code:${id}`,encryptAuthPayload(payload,authEmailJobContext({id:jobId,message_type:AUTH_EMAIL_PURPOSES[purpose],challenge_id:id}),keys),keys.version,id])
  })
  return genericResponse(id)
}

export async function createEmailSession(client,user,request) {
  const token=createSessionToken()
  const s=await client.query(`INSERT INTO sessions(user_id,token_hash,ip_address,user_agent,expires_at)
    VALUES($1,$2,$3,$4,NOW()+($5 || ' days')::interval) RETURNING id`,[user.id,hashSessionToken(token),request.ip,String(request.headers['user-agent'] || '').slice(0,1000),String(config.sessionTtlDays)])
  await client.query('UPDATE users SET last_login_at=NOW() WHERE id=$1',[user.id])
  return {token,user:sanitizeUser(user),sessionId:s.rows[0].id}
}

export async function consumeEmailChallenge({request,reply,purpose,body,callback}) {
  await requireEmailCapability(purpose)
  const keys=await loadAuthEmailKeys()
  const origin=authEmailOrigin(request)
  const flow=authEmailFlow(request,reply,purpose)
  const outcome=await withTransaction(async client=>{
    // Establish a uniform user -> challenge lock order for resets, logins and resends.
    const lookup=await client.query('SELECT user_id FROM auth_email_challenges WHERE id=$1',[body.challengeId])
    const userId=lookup.rows[0]?.user_id
    const user=userId?(await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0]:null
    const selected=await client.query('SELECT *, expires_at>NOW() AS fresh FROM auth_email_challenges WHERE id=$1 FOR UPDATE',[body.challengeId])
    const c=selected.rows[0]
    let proofKeys
    try { proofKeys=authEmailKeyVersion(keys,c?.key_version) } catch { return null }
    if(!c || !user || c.purpose!==purpose || c.origin!==origin || !flow || !equalDigest(c.flow_digest,flow)
      || !c.fresh || c.consumed_at || c.revoked_at || c.failed_attempts>=5
      || c.credential_version!==user.auth_version || user.status!=='approved' || isReleaseAcceptanceUsername(user.username)
      || (request.currentUser && request.currentUser.id!==user.id)
      || (purpose!=='email_bind' && (!user.email_verified_at || !equalDigest(emailKeyDigest(normalizeEmailAddress(user.email),proofKeys),c.email_key_digest)))) return null
    if(request.currentUser) {
      const session=await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE',[request.session.id,user.id])
      if(!session.rowCount)return null
    }
    if(!equalDigest(c.code_mac,emailCodeMac(c,body.code,proofKeys))) {
      await client.query('UPDATE auth_email_challenges SET failed_attempts=failed_attempts+1 WHERE id=$1',[c.id])
      return null // Commit the failure counter; throwing here would roll it back.
    }
    const result=await callback({client,user,challenge:c,keys,proofKeys})
    await client.query('UPDATE auth_email_challenges SET consumed_at=NOW() WHERE id=$1',[c.id])
    return result
  })
  if(!outcome)throw new AuthEmailError('AUTH_EMAIL_CODE_INVALID',400)
  return outcome
}

export async function resetEmailPassword({client,user,challenge,keys,request,body}) {
  const validation=validateNewPassword(body.newPassword)
  if(!validation.valid || body.newPassword!==body.confirmPassword)throw new AuthEmailError('AUTH_EMAIL_PASSWORD_INVALID')
  if(await verifyPassword(body.newPassword,user.password_hash))throw new AuthEmailError('AUTH_EMAIL_PASSWORD_UNCHANGED')
  await client.query('UPDATE users SET password_hash=$2,password_changed_at=NOW(),updated_at=NOW() WHERE id=$1',[user.id,await hashPassword(body.newPassword)])
  await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id])
  await client.query('UPDATE auth_email_challenges SET revoked_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL',[user.id])
  await client.query('UPDATE account_recovery_codes SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1',[user.id])
  await recordSecurityEvent({client,request,eventType:challenge.purpose==='password_reset'?'auth.password.reset':'auth.account.password.update',outcome:'success',subjectUserId:user.id,resourceType:'account',resourceId:user.id})
  await enqueueAuthNotice(client,{userId:user.id,recipient:user.email,type:'auth.password.changed',dedupeKey:`password:${challenge.id}`,text:'您的 DOMO NAV 密码已修改，全部设备已退出。如果不是您本人操作，请使用账号恢复流程处理。'},keys)
  return {ok:true,signInRequired:true}
}

export async function createEmailReauth(request,reply,password) {
  const id=randomUUID(),secret=randomBytes(32).toString('base64url')
  await withTransaction(async client=>{
    const user=(await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[request.currentUser.id])).rows[0]
    if(!user || user.status!=='approved' || !await verifyPassword(password,user.password_hash))throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
    await client.query('DELETE FROM auth_reauth_grants WHERE user_id=$1 AND session_id=$2',[user.id,request.session.id])
    await client.query(`INSERT INTO auth_reauth_grants(id,user_id,session_id,flow_digest,credential_version)
      VALUES($1,$2,$3,$4,$5)`,[id,user.id,request.session.id,proofDigest(secret),user.auth_version])
  })
  reply.setCookie('nav_email_reauth',`${id}.${secret}`,cookieOptions())
  return {ok:true,expiresIn:300}
}

export async function getEmailReauth(request,client=pool,{lock=false}={}) {
  const cookie=String(request.cookies?.nav_email_reauth || '')
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(cookie))throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
  const [id,secret]=cookie.split('.')
  const r=await client.query(`SELECT g.* FROM auth_reauth_grants g JOIN users u ON u.id=g.user_id
    WHERE g.id=$1 AND g.user_id=$2 AND g.session_id=$3 AND g.flow_digest=$4 AND g.expires_at>NOW()
    AND g.credential_version=u.auth_version ${lock?'FOR UPDATE OF g':''}`,[id,request.currentUser.id,request.session.id,proofDigest(secret)])
  if(!r.rowCount)throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
  return r.rows[0]
}

export async function bindEmailIdentity({request,client,user,challenge,keys,proofKeys=keys}) {
  const grant=await getEmailReauth(request,client,{lock:true})
  if(grant.id!==challenge.grant_id || (user.email_verified_at && !grant.old_email_verified_at))throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
  const email=normalizeEmailAddress(decryptAuthPayload(challenge.email_ciphertext,`email:${challenge.id}`,proofKeys).email)
  const occupied=await client.query('SELECT id FROM users WHERE LOWER(email)=$1 AND id<>$2',[email,user.id])
  if(occupied.rowCount)throw new AuthEmailError('AUTH_EMAIL_BIND_REJECTED')
  const changed=await client.query('UPDATE users SET email=$2,email_verified_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *',[user.id,email])
  await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id])
  await client.query('UPDATE auth_email_challenges SET revoked_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL',[user.id])
  await client.query('UPDATE account_recovery_codes SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1',[user.id])
  await recordSecurityEvent({client,request,eventType:user.email_verified_at?'auth.account.email.change':'auth.account.email.bind',outcome:'success',subjectUserId:user.id,resourceType:'account',resourceId:user.id})
  for(const recipient of new Set([user.email_verified_at?user.email:null,email].filter(Boolean))) {
    await enqueueAuthNotice(client,{userId:user.id,recipient,type:'auth.email.changed',dedupeKey:`email:${challenge.id}:${emailKeyDigest(recipient,keys)}`,text:'您的 DOMO NAV 账号恢复邮箱已变更，其他设备已退出。如果不是您本人操作，请立即检查账号安全。'},keys)
  }
  const session=await createEmailSession(client,changed.rows[0],request)
  return {ok:true,...session}
}
