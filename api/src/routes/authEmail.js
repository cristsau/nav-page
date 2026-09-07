import { pool } from '../db/index.js'
import { validateNewPassword } from '../lib/auth.js'
import { recordSecurityEvent } from '../lib/securityEvents.js'
import { issueActionProof } from '../lib/authActionProof.js'
import {
  AuthEmailError, authEmailReadiness, enforceEmailIpLimit, issueEmailChallenge,
  consumeEmailChallenge, createEmailSession, resetEmailPassword, createEmailReauth,
  getEmailReauth, bindEmailIdentity
} from '../lib/authEmailChallenges.js'

const email = { type:'string', minLength:3, maxLength:320, format:'email' }
const password = { type:'string', minLength:1, maxLength:2048 }
const proof = {
  challengeId:{ type:'string', format:'uuid' },
  code:{ type:'string', pattern:'^[0-9]{6}$' }
}
const newPasswords = { newPassword:password, confirmPassword:password }
function validatePasswords(body) {
  if(!validateNewPassword(body.newPassword).valid || body.newPassword!==body.confirmPassword) {
    throw new AuthEmailError('AUTH_EMAIL_PASSWORD_INVALID')
  }
}

export default async function authEmailRoutes(app) {
  app.addHook('onRequest',async (_request,reply)=>{ reply.header('Cache-Control','no-store') })
  app.setErrorHandler((error,request,reply)=>{
    const known=error instanceof AuthEmailError
    const status=known?error.statusCode:(error.validation?400:(error.code==='23505'?400:503))
    if(error.retryAfter)reply.header('Retry-After',error.retryAfter)
    if(!known && !error.validation && error.code!=='23505')request.log.error({event:'auth_email_unavailable'},'Authentication email operation unavailable')
    reply.code(status).send({code:known?error.code:(status===400?'AUTH_EMAIL_REQUEST_INVALID':'AUTH_EMAIL_UNAVAILABLE'),error:known?error.code:(status===400?'请求格式不正确':'邮箱验证暂不可用，请稍后重试或使用账号密码')})
  })
  function post(path,properties,{authenticated=false,operation='request',required=Object.keys(properties)}={},handler) {
    app.post(path,{
      bodyLimit:12288,
      config:{skipSession:!authenticated},
      schema:{body:{type:'object',additionalProperties:false,required,properties}},
      preValidation:async(request)=>{
        // Reject extras before AJV's default removeAdditional can silently strip them.
        if(!request.body || Object.keys(request.body).some(key=>!Object.hasOwn(properties,key)))throw new AuthEmailError('AUTH_EMAIL_REQUEST_INVALID')
      }
    },async(request,reply)=>{
      if(authenticated && !request.currentUser)throw new AuthEmailError('AUTHENTICATION_REQUIRED',401)
      await enforceEmailIpLimit(request,operation)
      return handler(request,reply)
    })
  }
  app.get('/auth/capabilities',{config:{skipSession:true}},async()=>({
    password:true,recoveryCode:true,passkey:false,...await authEmailReadiness(),
    // Identity Provider capabilities retain their independently verified endpoint.
    identityProviderConfig:'/api/auth/oauth/config'
  }))
  for(const [path,purpose] of [['email-login','login'],['password-reset','password_reset']]) {
    post(`/auth/${path}/request`,{email},{},async(request,reply)=>{
      const result=await issueEmailChallenge({request,reply,purpose,email:request.body.email})
      return reply.code(202).send(result)
    })
  }
  post('/auth/email-login/verify',proof,{operation:'verify'},async(request,reply)=>{
    const result=await consumeEmailChallenge({request,reply,purpose:'login',body:request.body,callback:async({client,user})=>{
      const session=await createEmailSession(client,user,request)
      await recordSecurityEvent({client,request,eventType:'auth.email.login',outcome:'success',subjectUserId:user.id,resourceType:'account',resourceId:user.id})
      return session
    }})
    await app.setSessionCookie(reply,result.token)
    return {user:result.user}
  })
  for(const [path,purpose,authenticated] of [
    ['/auth/password-reset/confirm','password_reset',false],
    ['/auth/account/password/email/confirm','password_change',true]
  ]) {
    post(path,{...proof,...newPasswords},{authenticated,operation:'verify'},async(request,reply)=>{
      validatePasswords(request.body)
      const result=await consumeEmailChallenge({request,reply,purpose,body:request.body,
        callback:args=>resetEmailPassword({...args,request,body:request.body})})
      await app.clearSessionCookie(reply)
      return result
    })
  }
  app.get('/auth/account/email',async(request)=>{
    if(!request.currentUser)throw new AuthEmailError('AUTHENTICATION_REQUIRED',401)
    const {rows}=await pool.query('SELECT email,email_verified_at FROM users WHERE id=$1',[request.currentUser.id])
    const value=rows[0]?.email || ''
    const at=value.lastIndexOf('@')
    return {maskedEmail:at>0?`${value.slice(0,1)}***${value.slice(at)}`:'',verified:Boolean(rows[0]?.email_verified_at),...await authEmailReadiness()}
  })
  app.get('/admin/auth-email/status',async(request)=>{
    if(!request.currentUser)throw new AuthEmailError('AUTHENTICATION_REQUIRED',401)
    if(request.currentUser.role!=='admin')throw new AuthEmailError('ADMIN_REQUIRED',403)
    const jobs=await pool.query(`SELECT state,COUNT(*)::int AS count FROM auth_email_delivery_jobs GROUP BY state`)
    const coverage=await pool.query(`SELECT COUNT(*) FILTER(WHERE status='approved')::int AS active,
      COUNT(*) FILTER(WHERE status='approved' AND email_verified_at IS NOT NULL AND email IS NOT NULL)::int AS verified FROM users`)
    const challenges=await pool.query(`SELECT COUNT(*)::int AS requested,
      COUNT(*) FILTER(WHERE consumed_at IS NOT NULL)::int AS consumed,
      COUNT(*) FILTER(WHERE revoked_at IS NOT NULL)::int AS revoked,
      COUNT(*) FILTER(WHERE expires_at<=NOW() AND consumed_at IS NULL)::int AS expired,
      COALESCE(SUM(failed_attempts),0)::int AS failed_attempts
      FROM auth_email_challenges WHERE created_at>NOW()-INTERVAL '24 hours'`)
    const age=await pool.query(`SELECT COALESCE(EXTRACT(EPOCH FROM NOW()-MIN(created_at))::int,0) AS seconds
      FROM auth_email_delivery_jobs WHERE state='pending'`)
    return {capabilities:await authEmailReadiness(),queue:Object.fromEntries(jobs.rows.map(r=>[r.state,r.count])),
      coverage:coverage.rows[0],challenges:challenges.rows[0],oldestPendingSeconds:age.rows[0].seconds,
      scope:'Retained operational aggregates; requested includes decoys, consumed counts are not mailbox receipts.'}
  })
  post('/auth/account/password/email/request',{}, {authenticated:true},async(request,reply)=>{
    const user=(await pool.query('SELECT email,email_verified_at FROM users WHERE id=$1',[request.currentUser.id])).rows[0]
    if(!user?.email_verified_at)throw new AuthEmailError('AUTH_EMAIL_BIND_REQUIRED')
    return reply.code(202).send(await issueEmailChallenge({request,reply,purpose:'password_change',email:user.email,userId:request.currentUser.id}))
  })
  post('/auth/account/reauth/password',{currentPassword:password},{authenticated:true,operation:'verify'},
    (request,reply)=>createEmailReauth(request,reply,request.body.currentPassword))
  post('/auth/action/reauth',{
    currentPassword:password,method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},path:{type:'string',maxLength:160}
  },{authenticated:true,operation:'verify'},(request,reply)=>issueActionProof(request,reply,request.body))
  post('/auth/account/email-change/request',{}, {authenticated:true},async(request,reply)=>{
    const grant=await getEmailReauth(request)
    const user=(await pool.query('SELECT email,email_verified_at FROM users WHERE id=$1',[request.currentUser.id])).rows[0]
    if(!user?.email_verified_at)throw new AuthEmailError('AUTH_EMAIL_BIND_REQUIRED')
    return reply.code(202).send(await issueEmailChallenge({request,reply,purpose:'email_change',email:user.email,userId:request.currentUser.id,grantId:grant.id}))
  })
  post('/auth/account/email-bind/request',{email,...proof},{authenticated:true,required:['email']},async(request,reply)=>{
    const grant=await getEmailReauth(request)
    const user=(await pool.query('SELECT email_verified_at FROM users WHERE id=$1',[request.currentUser.id])).rows[0]
    if(user?.email_verified_at && !grant.old_email_verified_at) {
      if(!request.body.challengeId || !request.body.code)throw new AuthEmailError('AUTH_EMAIL_OLD_EMAIL_REQUIRED')
      await enforceEmailIpLimit(request,'verify')
      await consumeEmailChallenge({request,reply,purpose:'email_change',body:request.body,callback:async({client,challenge})=>{
        const live=await getEmailReauth(request,client,{lock:true})
        if(live.id!==challenge.grant_id)throw new AuthEmailError('AUTH_EMAIL_REAUTH_REQUIRED',403)
        await client.query('UPDATE auth_reauth_grants SET old_email_verified_at=NOW() WHERE id=$1',[live.id])
        return {ok:true}
      }})
    }
    return reply.code(202).send(await issueEmailChallenge({request,reply,purpose:'email_bind',email:request.body.email,userId:request.currentUser.id,grantId:grant.id}))
  })
  post('/auth/account/email-bind/confirm',proof,{authenticated:true,operation:'verify'},async(request,reply)=>{
    const result=await consumeEmailChallenge({request,reply,purpose:'email_bind',body:request.body,
      callback:args=>bindEmailIdentity({...args,request})})
    await app.setSessionCookie(reply,result.token)
    return {ok:true,user:result.user}
  })
}
