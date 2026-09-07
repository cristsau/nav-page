import {randomBytes} from 'node:crypto'
import {pool,withTransaction} from '../db/index.js'
import {verifyPassword} from './auth.js'
import {proofDigest} from './authEmailCrypto.js'
import {AuthEmailError} from './authEmailChallenges.js'
import {config,isProduction} from '../config.js'

export function actionRequestPath(request) {
  try {return decodeURIComponent(String(request.url).split('?')[0]).replace(/^\/api(?=\/)/,'').replace(/\/+$/,'')}
  catch {return ''}
}
export function passwordProtectedAction(method,path) {
  if(method==='GET')return ['/migration/export-cloud','/migration/export-cloud-stream','/migration/restore/safety-backup'].includes(path)
  return ['POST','PUT','PATCH','DELETE'].includes(method) && (
    /^\/admin\/integrations\/(system-mail|cloud-backup)(\/test-smtp|\/test)?$/.test(path)
    || /^\/admin\/oauth-integrations\/identity(\/(google|wechat)\/test)?$/.test(path)
    || /^\/admin\/telegram-config(\/test)?$/.test(path)
  )
}
export async function issueActionProof(request,reply,{currentPassword,method,path}) {
  if(!passwordProtectedAction(method,path))throw new AuthEmailError('AUTH_ACTION_INVALID')
  if(path.startsWith('/admin/') && request.currentUser.role!=='admin')throw new AuthEmailError('ADMIN_REQUIRED',403)
  const secret=randomBytes(32).toString('base64url')
  await withTransaction(async client=>{
    const user=(await client.query('SELECT password_hash,auth_version,status FROM users WHERE id=$1 FOR UPDATE',[request.currentUser.id])).rows[0]
    if(!user || user.status!=='approved' || !await verifyPassword(currentPassword,user.password_hash))throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
    const session=await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE',[request.session.id,request.currentUser.id])
    if(!session.rowCount)throw new AuthEmailError('AUTHENTICATION_REQUIRED',401)
    await client.query('DELETE FROM auth_action_grants WHERE session_id=$1 AND method=$2 AND action_path=$3',[request.session.id,method,path])
    await client.query(`INSERT INTO auth_action_grants(token_digest,user_id,session_id,method,action_path,credential_version)
      VALUES($1,$2,$3,$4,$5,$6)`,[proofDigest(secret),request.currentUser.id,request.session.id,method,path,user.auth_version])
  })
  reply.setCookie('nav_action_reauth',secret,{httpOnly:true,secure:config.sessionCookieSecure || isProduction(),sameSite:'strict',path:'/api',maxAge:300})
  return {ok:true,expiresIn:300}
}
export async function consumeActionProof(request) {
  const secret=request.cookies?.nav_action_reauth || ''
  if(!/^[A-Za-z0-9_-]{43}$/.test(secret))return false
  const path=actionRequestPath(request)
  const r=await pool.query(`DELETE FROM auth_action_grants g USING users u,sessions s
    WHERE g.token_digest=$1 AND g.user_id=$2 AND g.session_id=$3 AND g.method=$4 AND g.action_path=$5
    AND g.expires_at>NOW() AND u.id=g.user_id AND u.auth_version=g.credential_version AND u.status='approved'
    AND s.id=g.session_id AND s.expires_at>NOW() RETURNING g.token_digest`,[proofDigest(secret),request.currentUser.id,request.session.id,request.method,path])
  return r.rowCount===1
}
