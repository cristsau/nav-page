import test from 'node:test'
import assert from 'node:assert/strict'
import { createBotGuard,botGuardPublicConfig } from '../src/lib/botGuard.js'
const runtime={turnstileEnabled:true,turnstileSiteKey:'synthetic-site',turnstileSecretKey:'synthetic-secret'}
const request={hostname:'nav.skrskr.net',headers:{origin:'https://nav.skrskr.net'},ip:'198.51.100.5',body:{turnstileToken:'synthetic-token'}}
const now=Date.now()
const valid={success:true,hostname:request.hostname,action:'register',challenge_ts:new Date(now).toISOString()}
test('disabled bot guard makes no database or network calls; secret never reaches public config',async()=>{
 await createBotGuard({runtime:{},fetchFn:()=>assert.fail(),consume:()=>assert.fail()})({},'register')
 const publicConfig=botGuardPublicConfig(runtime)
 assert.equal(publicConfig.siteKey,runtime.turnstileSiteKey)
 assert.equal(JSON.stringify(publicConfig).includes(runtime.turnstileSecretKey),false)
})
test('Siteverify is mandatory and bound to hostname/action/freshness; failure never bypasses',async()=>{
 for(const patch of [{},{success:false},{hostname:'nav.cristsau.cn'},{action:'email_login'},{challenge_ts:'invalid'},{challenge_ts:new Date(now-300001).toISOString()}]) {
  let calls=0
  const guard=createBotGuard({runtime,now:()=>now,fetchFn:async(url,options)=>{
    calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(options.redirect,'error')
    assert.deepEqual(JSON.parse(options.body),{secret:runtime.turnstileSecretKey,response:'synthetic-token'})
    return {ok:true,json:async()=>({...valid,...patch})}
  }})
  if(Object.keys(patch).length)await assert.rejects(guard(request,'register'),{code:'BOT_CHALLENGE_INVALID'})
  else await guard(request,'register')
  assert.equal(calls,1)
 }
 await assert.rejects(createBotGuard({runtime,fetchFn:()=>{throw new Error('timeout')}})(request,'register'),{code:'BOT_GUARD_UNAVAILABLE',statusCode:503})
})
test('missing/oversized tokens and alien origin fail before external calls',async()=>{
 const guard=createBotGuard({runtime,fetchFn:()=>assert.fail('must not call provider')})
 for(const token of [undefined,'',{},'x'.repeat(2049)])await assert.rejects(guard({...request,body:{turnstileToken:token}},'register'))
 await assert.rejects(guard({...request,headers:{origin:'https://evil.test'}},'register'),{code:'BOT_ORIGIN_INVALID'})
 await assert.rejects(createBotGuard({runtime:{...runtime,turnstileSecretKey:''}})(request,'register'),{statusCode:503})
})
test('password low-risk attempts stay frictionless; persistent threshold is server authoritative',async()=>{
 let allowed=true,calls=0
 const guard=createBotGuard({runtime,consume:async(_ip,policy)=>{assert.equal(policy.limit,3);assert.equal(policy.windowMs,600000);return {allowed}},fetchFn:async()=>{calls++;return {ok:true,json:async()=>({...valid,action:'password_login'})}},now:()=>now})
 await guard({...request,body:{}},'password_login');assert.equal(calls,0)
 allowed=false
 await assert.rejects(guard({...request,body:{}},'password_login'),{code:'BOT_CHALLENGE_REQUIRED'})
 await guard(request,'password_login');assert.equal(calls,1)
})
