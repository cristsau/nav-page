import assert from 'node:assert/strict'
import test,{before,after,beforeEach} from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomBytes,randomUUID} from 'node:crypto'

assert.equal(process.env.NODE_ENV,'test')
assert.equal(process.env.NAV_AUTH_EMAIL_INTEGRATION_TEST,'true')
const target=new URL(process.env.DATABASE_URL)
assert.ok(['localhost','127.0.0.1'].includes(target.hostname))
assert.equal(target.pathname,'/nav_auth_email_test')
assert.equal(target.search,'')
const {config}=await import('../src/config.js')
const {pool,runMigrations}=await import('../src/db/index.js')
const {createApp}=await import('../src/app.js')
const {hashPassword,verifyPassword}=await import('../src/lib/auth.js')
const {loadAuthEmailKeys,authEmailJobContext,decryptAuthPayload,emailCodeMac}=await import('../src/lib/authEmailCrypto.js')
const {deliverAuthEmails}=await import('../src/lib/authEmailDelivery.js')
const A='https://auth-a.example.test',B='https://auth-b.example.test'
const oldPassword='integration-password-original'
const newPassword='integration-password-replaced'
let app,temp,keys,userId,baselineHash

before(async()=>{
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'nav-auth-email-test-'))
  const keyFile=path.join(temp,'keys.json'),smtpFile=path.join(temp,'smtp.txt')
  await fs.writeFile(keyFile,JSON.stringify({version:1,hmacKey:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')}),{mode:0o600})
  await fs.writeFile(smtpFile,randomBytes(24).toString('hex'),{mode:0o600})
  Object.assign(config,{emailLoginEnabled:true,emailPasswordResetEnabled:true,authEmailKeysFile:keyFile,
    mailDeliveryEnabled:true,smtpHost:'smtp.example.test',smtpPort:465,smtpSecure:true,smtpUsername:'sender@example.test',smtpFromAddress:'sender@example.test',smtpPasswordFile:smtpFile,
    corsOrigin:`${A},${B}`,rateLimitKeySecret:randomBytes(32).toString('hex'),apiLogLevel:'silent'})
  // First establish the deployed pre-047 schema, then upgrade a real synthetic account.
  await runMigrations({fileSystem:{...fs,readdir:async(...args)=>(await fs.readdir(...args)).filter(entry=>entry.name!=='047_auth_email_challenges.sql')}})
  const upgradeUser=randomUUID(),upgradeHash=await hashPassword(oldPassword)
  await pool.query("INSERT INTO users(id,username,password_hash,role,status) VALUES($1,'synthetic-upgrade',$2,'admin','approved')",[upgradeUser,upgradeHash])
  await runMigrations()
  const upgraded=(await pool.query('SELECT password_hash,auth_version FROM users WHERE id=$1',[upgradeUser])).rows[0]
  assert.equal(upgraded.password_hash,upgradeHash)
  assert.equal(upgraded.auth_version,'0')
  keys=await loadAuthEmailKeys()
  baselineHash=await hashPassword(oldPassword)
  app=createApp();await app.ready()
})
after(async()=>{
  await app?.close();await pool.end()
  // Only the unique test-created directory, never a configured production path.
  if(temp?.startsWith(path.join(os.tmpdir(),'nav-auth-email-test-')))await fs.rm(temp,{recursive:true,force:true})
})
beforeEach(async()=>{
  await pool.query('TRUNCATE users,rate_limit_buckets,security_events RESTART IDENTITY CASCADE')
  userId=randomUUID()
  await pool.query(`INSERT INTO users(id,username,password_hash,role,status,email,email_verified_at)
    VALUES($1,'synthetic-auth-owner',$2,'admin','approved','owner@example.test',NOW())`,[userId,baselineHash])
})
function browser(origin=A,ip='198.51.100.10') {
  const cookies={}
  return {cookies,origin,async call(url,payload,method='POST') {
    const response=await app.inject({method,url:`/api${url}`,headers:{origin},remoteAddress:ip,cookies,payload})
    for(const c of response.cookies)cookies[c.name]=c.value
    return response
  }}
}
async function requestCode(b,route='/auth/email-login/request',payload={email:'owner@example.test'}) {
  const response=await b.call(route,payload)
  assert.equal(response.statusCode,202,response.json().code)
  const id=response.json().challengeId
  const {rows}=await pool.query('SELECT * FROM auth_email_delivery_jobs WHERE challenge_id=$1',[id])
  const job=rows[0]
  let code
  if(job) {
    const body=decryptAuthPayload(job.encrypted_payload,authEmailJobContext(job),keys)
    code=body.text.match(/验证码：(\d{6})/u)?.[1]
    assert.ok(Boolean(code))
  }
  return {challengeId:id,code,response,job}
}
async function passwordLogin(b) {
  const response=await b.call('/auth/login',{username:'synthetic-auth-owner',password:oldPassword})
  assert.equal(response.statusCode,200)
}
async function count(table,where='TRUE') {return Number((await pool.query(`SELECT COUNT(*) FROM ${table} WHERE ${where}`)).rows[0].count)}

test('A-02/08: twenty concurrent consumes produce exactly one session and audit',async()=>{
  const b=browser(),proof=await requestCode(b)
  const results=await Promise.all(Array.from({length:20},()=>b.call('/auth/email-login/verify',{challengeId:proof.challengeId,code:proof.code})))
  assert.equal(results.filter(r=>r.statusCode===200).length,1)
  assert.equal(await count('sessions'),1)
  assert.equal(await count('security_events',"event_type='auth.email.login'"),1)
})
test('A-03: unknown/unverified/unapproved identities return the same 202 shape without mail',async()=>{
  const b=browser()
  const valid=await requestCode(b)
  for(const [n,address] of ['missing@example.test','unverified@example.test','blocked@example.test'].entries()) {
    if(n>0)await pool.query(`INSERT INTO users(username,password_hash,role,status,email,email_verified_at)
      VALUES($1,$2,'user',$3,$4,$5)`,[`synthetic-${n}`,baselineHash,n===2?'pending':'approved',address,n===2?new Date():null])
    const unknown=await requestCode(browser(A,`198.51.100.${20+n}`),'/auth/email-login/request',{email:address})
    assert.deepEqual(Object.keys(unknown.response.json()),Object.keys(valid.response.json()))
    assert.equal(unknown.response.json().message,valid.response.json().message)
    assert.equal(unknown.challengeId.length,valid.challengeId.length)
    assert.equal(unknown.job,undefined)
  }
  assert.equal(await count('sessions'),0)
})
test('A-07: five wrong codes commit failures; a correct sixth cannot succeed',async()=>{
  const b=browser(),proof=await requestCode(b)
  const wrong=proof.code==='000000'?'000001':'000000'
  for(let i=0;i<5;i++)assert.equal((await b.call('/auth/email-login/verify',{challengeId:proof.challengeId,code:wrong})).statusCode,400)
  assert.equal((await pool.query('SELECT failed_attempts FROM auth_email_challenges WHERE id=$1',[proof.challengeId])).rows[0].failed_attempts,5)
  assert.equal((await b.call('/auth/email-login/verify',{challengeId:proof.challengeId,code:proof.code})).statusCode,400)
  await passwordLogin(b)
})
test('A-04/09/24: origin, purpose and flow cannot be interchanged; frozen user rejected',async()=>{
  const b=browser(),proof=await requestCode(b)
  const other=browser(B)
  Object.assign(other.cookies,b.cookies)
  assert.equal((await other.call('/auth/email-login/verify',{challengeId:proof.challengeId,code:proof.code})).statusCode,400)
  assert.equal((await browser().call('/auth/email-login/verify',{challengeId:proof.challengeId,code:proof.code})).statusCode,400)
  assert.equal((await b.call('/auth/password-reset/confirm',{challengeId:proof.challengeId,code:proof.code,newPassword,confirmPassword:newPassword})).statusCode,400)
  await pool.query("UPDATE users SET status='rejected' WHERE id=$1",[userId])
  assert.equal((await b.call('/auth/email-login/verify',{challengeId:proof.challengeId,code:proof.code})).statusCode,400)
  assert.equal(await count('sessions'),0)
})
test('A-05/06: schema rejects malformed code; DB expiry and leading zero are honored',async()=>{
  const b=browser(),p=await requestCode(b)
  for(const code of ['12345','1234567','ABCDEF'])assert.equal((await b.call('/auth/email-login/verify',{challengeId:p.challengeId,code})).statusCode,400)
  const c=(await pool.query('SELECT * FROM auth_email_challenges WHERE id=$1',[p.challengeId])).rows[0]
  await pool.query('UPDATE auth_email_challenges SET code_mac=$2 WHERE id=$1',[c.id,emailCodeMac(c,'000123',keys)])
  assert.equal((await b.call('/auth/email-login/verify',{challengeId:p.challengeId,code:'000123'})).statusCode,200)
  const second=await requestCode(browser(B))
  await pool.query("UPDATE auth_email_challenges SET created_at=NOW()-INTERVAL '301 seconds',expires_at=NOW() WHERE id=$1",[second.challengeId])
  const expired=browser(B);Object.assign(expired.cookies,second.response.cookies.reduce((a,c)=>({...a,[c.name]:c.value}),{}))
  assert.equal((await expired.call('/auth/email-login/verify',{challengeId:second.challengeId,code:second.code})).statusCode,400)
})
test('A-10: resend invalidates same flow only',async()=>{
  const a=browser(),b=browser(B)
  const first=await requestCode(a),other=await requestCode(b)
  await pool.query("UPDATE rate_limit_buckets SET window_started_at=NOW()-INTERVAL '61 seconds',window_expires_at=NOW()-INTERVAL '1 second' WHERE scope='email_resend'")
  const second=await requestCode(a)
  assert.equal((await a.call('/auth/email-login/verify',{challengeId:first.challengeId,code:first.code})).statusCode,400)
  assert.equal((await b.call('/auth/email-login/verify',{challengeId:other.challengeId,code:other.code})).statusCode,200)
  assert.equal((await a.call('/auth/email-login/verify',{challengeId:second.challengeId,code:second.code})).statusCode,200)
})
test('A-16/17/18: reset atomically invalidates all sessions/proofs; no automatic login',async()=>{
  const a=browser(),b=browser(B)
  await passwordLogin(a);await passwordLogin(b)
  const old=await requestCode(a)
  const reset=await requestCode(browser(),'/auth/password-reset/request')
  const recovery=browser();for(const c of reset.response.cookies)recovery.cookies[c.name]=c.value
  const payload={challengeId:reset.challengeId,code:reset.code,newPassword,confirmPassword:newPassword}
  assert.equal((await recovery.call('/auth/password-reset/confirm',{...payload,confirmPassword:'not-matching'})).statusCode,400)
  const done=await recovery.call('/auth/password-reset/confirm',payload)
  assert.equal(done.statusCode,200,done.json().code)
  assert.equal(done.json().signInRequired,true)
  assert.equal(await count('sessions'),0)
  assert.equal((await a.call('/auth/email-login/verify',{challengeId:old.challengeId,code:old.code})).statusCode,400)
  const hash=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[userId])).rows[0].password_hash
  assert.equal(await verifyPassword(oldPassword,hash),false)
  assert.equal(await verifyPassword(newPassword,hash),true)
  assert.equal(await count('auth_email_delivery_jobs',"message_type='auth.password.changed'"),1)
})
test('A-25: notification insert failure rolls password/session/challenge transaction back',async()=>{
  const b=browser();await passwordLogin(b)
  const p=await requestCode(b,'/auth/account/password/email/request',{})
  await pool.query(`CREATE FUNCTION test_auth_notice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.message_type='auth.password.changed' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER test_auth_notice_failure BEFORE INSERT ON auth_email_delivery_jobs FOR EACH ROW EXECUTE FUNCTION test_auth_notice_failure()`)
  try {
    const r=await b.call('/auth/account/password/email/confirm',{challengeId:p.challengeId,code:p.code,newPassword,confirmPassword:newPassword})
    assert.equal(r.statusCode,503)
    assert.equal(await count('sessions'),1)
    const u=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[userId])).rows[0]
    assert.equal(u.password_hash,baselineHash)
    assert.equal(await count('auth_email_challenges','consumed_at IS NOT NULL'),0)
  } finally {await pool.query('DROP TRIGGER test_auth_notice_failure ON auth_email_delivery_jobs; DROP FUNCTION test_auth_notice_failure()')}
})
test('A-19/20/21: change binding requires password, old mailbox proof and new mailbox proof',async()=>{
  const b=browser();await passwordLogin(b)
  assert.equal((await b.call('/auth/account/email-bind/request',{email:'replacement@example.test'})).statusCode,403)
  assert.equal((await b.call('/auth/account/reauth/password',{currentPassword:oldPassword})).statusCode,200)
  assert.equal((await b.call('/auth/account/email-bind/request',{email:'replacement@example.test'})).statusCode,400)
  const old=await requestCode(b,'/auth/account/email-change/request',{})
  const next=await requestCode(b,'/auth/account/email-bind/request',{email:'replacement@example.test',challengeId:old.challengeId,code:old.code})
  const result=await b.call('/auth/account/email-bind/confirm',{challengeId:next.challengeId,code:next.code})
  assert.equal(result.statusCode,200,result.json().code)
  assert.equal(await count('sessions'),1)
  assert.equal(await count('auth_reauth_grants'),0)
  assert.equal(await count('auth_email_delivery_jobs',"message_type='auth.email.changed'"),2)
  assert.equal((await pool.query('SELECT email FROM users WHERE id=$1',[userId])).rows[0].email,'replacement@example.test')
})
test('A-12/13/14: accepted SMTP clears ciphertext; expired/revoked work never sends',async()=>{
  const b=browser(),p=await requestCode(b)
  let sent=0
  const options={runtimeConfig:config,assertHost:async()=>{},transportFactory:async()=>({sendMail:async()=>{sent++;return {accepted:['synthetic'],rejected:[]}},close(){}})}
  assert.equal((await deliverAuthEmails(options)).accepted,1)
  assert.equal(sent,1)
  assert.equal((await pool.query('SELECT encrypted_payload FROM auth_email_delivery_jobs WHERE id=$1',[p.job.id])).rows[0].encrypted_payload,null)
  const q=await requestCode(browser(B))
  await pool.query('UPDATE auth_email_challenges SET revoked_at=NOW() WHERE id=$1',[q.challengeId])
  await deliverAuthEmails(options)
  assert.equal(sent,1)
  assert.equal((await pool.query('SELECT state FROM auth_email_delivery_jobs WHERE id=$1',[q.job.id])).rows[0].state,'cancelled')
})

test('A-11: identity hourly budget spans purposes, domains and distinct IPs',async()=>{
  for(let i=0;i<5;i++) {
    const b=browser(i%2?A:B,`198.51.100.${40+i}`)
    const p=await requestCode(b,i%2?'/auth/email-login/request':'/auth/password-reset/request')
    assert.ok(p.job)
  }
  const limited=await requestCode(browser(A,'198.51.100.90'))
  assert.equal(limited.job,undefined)
  assert.equal(await count('auth_email_delivery_jobs'),5)
  const counters=(await pool.query("SELECT request_count FROM rate_limit_buckets WHERE scope='email_identity_hour'")).rows
  assert.equal(counters.length,1)
  assert.equal(Number(counters[0].request_count),6)
})

test('A-11: fourth simultaneous flow cannot invalidate three existing challenges',async()=>{
  const proofs=[]
  for(let i=0;i<4;i++)proofs.push(await requestCode(browser(A,`198.51.100.${50+i}`)))
  assert.equal(proofs.filter(p=>p.job).length,3)
  assert.equal(await count('auth_email_challenges','user_id IS NOT NULL AND revoked_at IS NULL'),3)
})

test('A-12/13: uncertain DATA is never resent; explicit 451 retries at most three times',async()=>{
  const p=await requestCode(browser())
  let sent=0
  const options={runtimeConfig:config,assertHost:async()=>{},transportFactory:async()=>({sendMail:async()=>{
    sent++;throw Object.assign(new Error('synthetic SMTP uncertainty'),{command:'DATA',code:'ETIMEDOUT'})
  },close(){}})}
  assert.equal((await deliverAuthEmails(options)).unknown,1)
  await deliverAuthEmails(options)
  assert.equal(sent,1)
  assert.equal((await pool.query('SELECT encrypted_payload FROM auth_email_delivery_jobs WHERE id=$1',[p.job.id])).rows[0].encrypted_payload,null)
  const q=await requestCode(browser(B))
  options.transportFactory=async()=>({sendMail:async()=>{sent++;throw Object.assign(new Error('synthetic temporary rejection'),{command:'DATA',responseCode:451})},close(){}})
  for(let i=0;i<4;i++) {
    await pool.query('UPDATE auth_email_delivery_jobs SET next_attempt_at=NOW() WHERE id=$1',[q.job.id])
    await deliverAuthEmails(options)
  }
  assert.equal(sent,4)
  const job=(await pool.query('SELECT state,attempts,encrypted_payload FROM auth_email_delivery_jobs WHERE id=$1',[q.job.id])).rows[0]
  assert.deepEqual(job,{state:'failed',attempts:3,encrypted_payload:null})
})

test('A-22: email session needs current password for export, proof is scoped and single use',async()=>{
  const b=browser(),p=await requestCode(b)
  assert.equal((await b.call('/auth/email-login/verify',{challengeId:p.challengeId,code:p.code})).statusCode,200)
  const exportPath='/migration/export-cloud'
  assert.equal((await b.call(exportPath,undefined,'GET')).json().code,'PASSWORD_REAUTH_REQUIRED')
  assert.equal((await b.call('/auth/action/reauth',{currentPassword:'wrong',method:'GET',path:exportPath})).statusCode,403)
  const proof=await b.call('/auth/action/reauth',{currentPassword:oldPassword,method:'GET',path:exportPath})
  assert.equal(proof.statusCode,200,proof.json().code)
  assert.equal((await b.call('/migration/export-cloud-stream',undefined,'GET')).json().code,'PASSWORD_REAUTH_REQUIRED')
  assert.equal((await b.call('/migration/restore/safety-backup',undefined,'GET')).json().code,'PASSWORD_REAUTH_REQUIRED')
  assert.equal(await count('auth_action_grants'),1)
  const exported=await b.call(exportPath,undefined,'GET')
  assert.equal(exported.statusCode,200)
  assert.equal(await count('auth_action_grants'),0)
  assert.equal((await b.call(exportPath,undefined,'GET')).json().code,'PASSWORD_REAUTH_REQUIRED')
  assert.equal((await b.call('/admin/telegram-config',{},'PUT')).json().code,'PASSWORD_REAUTH_REQUIRED')
  assert.equal((await b.call('/admin/integrations/system-mail',{},'PUT')).json().code,'PASSWORD_REAUTH_REQUIRED')
})

test('A-22/24: sensitive grant is bound to session and revoked by identity version',async()=>{
  const a=browser(),b=browser();await passwordLogin(a);await passwordLogin(b)
  const action={currentPassword:oldPassword,method:'GET',path:'/migration/export-cloud'}
  assert.equal((await a.call('/auth/action/reauth',action)).statusCode,200)
  b.cookies.nav_action_reauth=a.cookies.nav_action_reauth
  assert.equal((await b.call(action.path,undefined,'GET')).json().code,'PASSWORD_REAUTH_REQUIRED')
  await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[userId,await hashPassword(newPassword)])
  assert.equal((await a.call(action.path,undefined,'GET')).json().code,'PASSWORD_REAUTH_REQUIRED')
})

test('A-19: first mailbox binding needs current password and target proof only',async()=>{
  await pool.query('UPDATE users SET email=NULL,email_verified_at=NULL WHERE id=$1',[userId])
  const b=browser();await passwordLogin(b)
  assert.equal((await b.call('/auth/account/reauth/password',{currentPassword:oldPassword})).statusCode,200)
  const proof=await requestCode(b,'/auth/account/email-bind/request',{email:'first@example.test'})
  const bound=await b.call('/auth/account/email-bind/confirm',{challengeId:proof.challengeId,code:proof.code})
  assert.equal(bound.statusCode,200,bound.json().code)
  assert.equal(await count('users','email_verified_at IS NOT NULL'),1)
  assert.equal(await count('sessions'),1)
})

test('A-16/17: existing password and recovery paths revoke email proofs and all sessions',async()=>{
  const b=browser();await passwordLogin(b)
  const p=await requestCode(b)
  const generated=await b.call('/auth/recovery-codes',{currentPassword:oldPassword})
  assert.equal(generated.statusCode,200)
  const change=await b.call('/auth/account/password',{currentPassword:oldPassword,newPassword},'PUT')
  assert.equal(change.statusCode,200,change.json().error)
  assert.equal(await count('sessions'),0)
  assert.equal(await count('account_recovery_codes','revoked_at IS NULL AND used_at IS NULL'),0)
  assert.equal((await b.call('/auth/email-login/verify',{challengeId:p.challengeId,code:p.code})).statusCode,400)
  // A fresh recovery bundle under the new credential must receive the same invalidation.
  assert.equal((await b.call('/auth/login',{username:'synthetic-auth-owner',password:newPassword})).statusCode,200)
  const bundle=await b.call('/auth/recovery-codes',{currentPassword:newPassword})
  assert.equal(bundle.statusCode,200)
  const code=bundle.json().codes[0]
  const q=await requestCode(browser(B))
  const recovered=await b.call('/auth/recover',{username:'synthetic-auth-owner',recoveryCode:code,newPassword:'integration-third-password'})
  assert.equal(recovered.statusCode,200,recovered.json().error)
  assert.equal(await count('sessions'),0)
  assert.equal(await count('account_recovery_codes','revoked_at IS NULL AND used_at IS NULL'),0)
  assert.equal(await count('auth_email_challenges',`id='${q.challengeId}' AND revoked_at IS NULL`),0)
})

test('A-15: missing keys fail closed without revoking password login',async()=>{
  const original=config.authEmailKeysFile
  config.authEmailKeysFile=path.join(temp,'not-present.json')
  try {
    const b=browser(),caps=await b.call('/auth/capabilities',undefined,'GET')
    assert.equal(caps.json().emailLogin,false)
    assert.equal((await b.call('/auth/email-login/request',{email:'owner@example.test'})).statusCode,503)
    await passwordLogin(b)
    assert.equal(await count('auth_email_delivery_jobs'),0)
  } finally {config.authEmailKeysFile=original}
})

test('A-14: private exports and admin aggregate contain neither OTP nor grant payloads',async()=>{
  const b=browser();await passwordLogin(b)
  const proof=await requestCode(b)
  assert.equal((await b.call('/auth/action/reauth',{currentPassword:oldPassword,method:'GET',path:'/migration/export-cloud'})).statusCode,200)
  const exported=await b.call('/migration/export-cloud',undefined,'GET')
  assert.equal(exported.statusCode,200)
  for(const needle of [proof.code,proof.job.encrypted_payload,proof.challengeId,'auth_email_challenges','auth_action_grants'])assert.equal(exported.body.includes(needle),false)
  const admin=await b.call('/admin/auth-email/status',undefined,'GET')
  assert.equal(admin.statusCode,200)
  assert.equal(admin.json().queue.pending,1)
  for(const needle of ['owner@example.test',proof.code,proof.job.encrypted_payload,proof.challengeId])assert.equal(admin.body.includes(needle),false)
})

test('P-02: disabled-email compatibility mode preserves password and both retirements',async()=>{
  const b=browser(),p=await requestCode(b)
  config.emailLoginEnabled=false;config.emailPasswordResetEnabled=false
  try {
    const caps=await b.call('/auth/capabilities',undefined,'GET')
    assert.equal(caps.json().emailLogin,false)
    await passwordLogin(b)
    assert.equal((await b.call('/auth/passkeys/config',undefined,'GET')).json().retired,true)
    assert.equal((await b.call('/auth/passkeys/login/options',{})).statusCode,410)
    await deliverAuthEmails({runtimeConfig:config})
    assert.equal((await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM auth_email_challenges WHERE id=$1',[p.challengeId])).rows[0].revoked,true)
    assert.equal((await pool.query('SELECT encrypted_payload FROM auth_email_delivery_jobs WHERE id=$1',[p.job.id])).rows[0].encrypted_payload,null)
  } finally {config.emailLoginEnabled=true;config.emailPasswordResetEnabled=true}
})

test('P-02: disaster restore SQL invalidates restored proof material before startup',async()=>{
  const b=browser();await passwordLogin(b);await requestCode(b)
  assert.equal((await b.call('/auth/action/reauth',{currentPassword:oldPassword,method:'GET',path:'/migration/export-cloud'})).statusCode,200)
  const script=await fs.readFile(process.env.NAV_AUTH_RESTORE_SCRIPT || new URL('../../scripts/nav-disaster-restore.sh',import.meta.url),'utf8')
  const block=script.match(/<<'AUTH_RESTORE_SQL'\r?\n([\s\S]*?)\r?\nAUTH_RESTORE_SQL/)
  assert.ok(block,'restore must contain explicit authentication invalidation')
  await pool.query(block[1])
  assert.equal(await count('sessions'),0)
  assert.equal(await count('auth_action_grants'),0)
  assert.equal(await count('auth_email_challenges','revoked_at IS NULL AND consumed_at IS NULL'),0)
  assert.equal(await count('auth_email_delivery_jobs','encrypted_payload IS NOT NULL'),0)
})
