import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {syntheticAuthenticator as authenticator} from './helpers/deviceKeyAuthenticator.js'
import {createDeviceKeyService,DEVICE_KEY_ORIGIN,DEVICE_KEY_RP_ID,DEVICE_KEY_SITES,deviceKeysAvailable,requireDeviceKeyOrigin,deviceKeyUserHandle,sanitizedTransports} from '../src/lib/deviceKeys.js'
import {config} from '../src/config.js'
import {hashPassword} from '../src/lib/auth.js'
const previous={deviceKeysEnabled:config.deviceKeysEnabled,rateLimitKeySecret:config.rateLimitKeySecret}
let passwordHash
before(async()=>{config.deviceKeysEnabled=true;config.rateLimitKeySecret=randomBytes(32).toString('hex');passwordHash=await hashPassword('synthetic-device-password')})
after(()=>Object.assign(config,previous))
const userId='11111111-1111-4111-8111-111111111111'
function fixture(site=DEVICE_KEY_SITES[0]) {
 const user={id:userId,username:'synthetic-device-owner',status:'approved',role:'user',auth_version:'3',auth_changed_at:new Date(0),password_hash:passwordHash}
 const statements=[],keys=[],challenges=new Map()
 let serial=0
 const client={query:async(sql,p=[])=>{
   statements.push({sql,p})
   const rows=value=>({rows:Array.isArray(value)?value:[value],rowCount:Array.isArray(value)?value.length:1})
   if(sql.startsWith('SELECT * FROM users'))return rows(user)
   if(sql.includes('SELECT u.*'))return rows(keys.some(k=>k.credential_id===p[0] && k.rp_id===p[1]) ? [user] : [])
   if(sql.startsWith('SELECT id FROM sessions'))return rows({id:'session-1'})
   if(sql.startsWith('SELECT id,device_key_id FROM sessions'))return rows({id:'session-1',device_key_id:null})
   if(sql.startsWith('SELECT id,label'))return rows(keys.filter(k=>k.user_id===p[0] && k.rp_id===p[1]))
   if(sql.startsWith('SELECT credential_id,transports'))return rows(keys)
   if(sql.includes('SELECT COUNT(*)'))return rows({count:keys.length})
   if(sql.startsWith('INSERT INTO auth_device_key_challenges')){
     const register=sql.includes("VALUES('register'")
     const id=`challenge-${++serial}`,value={id,kind:register?'register':'login',challenge_digest:p[0],flow_digest:p[1],origin:p[2],created_at:new Date(),credential_version:register?p[5]:null,label:register?p[6]:null,trust_device:register?false:p[3]}
     challenges.set(id,value);return rows(value)
   }
   if(sql.startsWith('DELETE FROM auth_device_key_challenges') && sql.includes('WHERE id=$1')){
     const value=challenges.get(p[0]);if(!value || value.flow_digest!==p[1] || value.origin!==p[value?.kind==='register'?4:2])return rows([])
     challenges.delete(p[0]);return rows(value)
   }
   if(sql.startsWith('INSERT INTO auth_device_keys')) {
     const value={id:`key-${keys.length+1}`,user_id:p[0],credential_id:p[1],public_key:p[2],counter:p[3],label:p[4],transports:JSON.parse(p[5]),device_type:p[6],backed_up:p[7],rp_id:p[8]}
     keys.push(value);return rows(value)
   }
   if(sql.startsWith('SELECT * FROM auth_device_keys'))return rows(keys.filter(k=>k.credential_id===p[0] && k.user_id===p[1] && k.rp_id===p[2]))
   if(sql.startsWith('UPDATE auth_device_keys SET counter')){keys.find(k=>k.id===p[0]).counter=p[1];return rows([])}
   if(sql.startsWith('DELETE FROM auth_device_keys WHERE id=')) {
     const index=keys.findIndex(k=>k.id===p[0] && k.user_id===p[1] && k.rp_id===p[2])
     return rows(index<0?[]:keys.splice(index,1))
   }
   if(sql.startsWith('INSERT INTO sessions'))return rows({id:'new-session'})
   return rows([])
 }}
 const cookies={},request={hostname:site.rpId,headers:{origin:site.origin},cookies,currentUser:user,session:{id:'session-1'}}
 const reply={setCookie:(name,value)=>{cookies[name]=value}}
 return {service:createDeviceKeyService({query:client.query,withTransaction:fn=>fn(client)}),request,reply,user,keys,challenges,statements}
}
test('opaque user handle and bounded transport allowlist contain no identity payload',()=>{
 assert.equal(Buffer.from(deviceKeyUserHandle(userId)).toString(),userId)
 assert.deepEqual(sanitizedTransports(['internal','internal','untrusted','usb']),['internal','usb'])
})
test('real ES256 registration and assertion create a bounded session; replay rejected',async()=>{
 const f=fixture(),a=authenticator()
 const enrollment=await f.service.registerOptions(f.request,f.reply,{currentPassword:'synthetic-device-password',name:'测试 iPhone'})
 assert.equal(enrollment.options.authenticatorSelection.userVerification,'required')
 assert.equal(enrollment.options.authenticatorSelection.residentKey,'required')
 const registered=await f.service.registerVerify(f.request,f.reply,{challengeId:enrollment.challengeId,response:a.register(enrollment.options.challenge)})
 assert.equal(registered.key.name,'测试 iPhone');assert.equal(f.keys.length,1)
 assert.equal(JSON.stringify(registered).includes(a.id),false)
 const login=await f.service.loginOptions(f.request,f.reply,{trustDevice:true})
 assert.equal(login.options.userVerification,'required');assert.ok(!login.options.allowCredentials?.length)
 const body={challengeId:login.challengeId,response:a.login(login.options.challenge)}
 const result=await f.service.loginVerify(f.request,f.reply,body)
 assert.equal(result.user.id,userId);assert.equal(result.trustDevice,true);assert.equal(f.keys[0].counter,1)
 const insert=f.statements.find(s=>s.sql.startsWith('INSERT INTO sessions'))
 assert.equal(insert.p[4],'30');assert.equal(insert.p[5],'key-1');assert.notEqual(insert.p[1],result.token)
 await assert.rejects(f.service.loginVerify(f.request,f.reply,body),{code:'DEVICE_KEY_INVALID'})
})
test('real signature checks reject UV absence, other origin/RP/challenge/handle, counter replay and tampering',async()=>{
 for(const [label,patch] of Object.entries({uv:{flags:1},origin:{origin:'https://nav.cristsau.cn'},rp:{rp:'evil.test'},handle:{userHandle:Buffer.from('other-user').toString('base64url')},counter:{counter:0},signature:{tamper:true},challenge:{challenge:'wrong-challenge'}})) {
   const f=fixture(),a=authenticator()
   f.keys.push({id:'key-1',user_id:userId,credential_id:a.id,public_key:a.publicKey,counter:1,transports:['internal'],rp_id:DEVICE_KEY_RP_ID})
   const login=await f.service.loginOptions(f.request,f.reply,{trustDevice:false})
   const body={challengeId:login.challengeId,response:a.login(patch.challenge || login.options.challenge,{counter:2,...patch})}
   await assert.rejects(f.service.loginVerify(f.request,f.reply,body),{code:'DEVICE_KEY_INVALID'},label)
   assert.equal(f.statements.some(s=>s.sql.startsWith('INSERT INTO sessions')),false,label)
   assert.equal(f.challenges.size,0,'failed cryptographic proof is consumed')
 }
})

test('both exact HTTPS sites enroll and authenticate with separate RPs; unknown sites and mismatches are rejected',async()=>{
 for(const site of DEVICE_KEY_SITES) {
   const f=fixture(site),a=authenticator(),options={origin:site.origin,rp:site.rpId}
   assert.equal(deviceKeysAvailable(f.request),true)
   const registration=await f.service.registerOptions(f.request,f.reply,{currentPassword:'synthetic-device-password',name:'合成设备'})
   assert.equal(registration.options.rp.id,site.rpId)
   const key=await f.service.registerVerify(f.request,f.reply,{challengeId:registration.challengeId,response:a.register(registration.options.challenge,options)})
   assert.equal(key.key.domain,site.rpId)
   const login=await f.service.loginOptions(f.request,f.reply,{})
   assert.equal(login.options.rpId,site.rpId)
   await f.service.loginVerify(f.request,f.reply,{challengeId:login.challengeId,response:a.login(login.options.challenge,options)})
   assert.equal((await f.service.list(userId,f.request)).length,1)
   const other=DEVICE_KEY_SITES.find(s=>s!==site),otherRequest={...f.request,hostname:other.rpId,headers:{origin:other.origin}}
   assert.equal((await f.service.list(userId,otherRequest)).length,0)
   await assert.rejects(f.service.remove(otherRequest,{id:key.key.id,currentPassword:'synthetic-device-password'}),{code:'DEVICE_KEY_INVALID'})
   const crossed=await f.service.loginOptions(otherRequest,f.reply,{})
   await assert.rejects(f.service.loginVerify(otherRequest,f.reply,{challengeId:crossed.challengeId,response:a.login(crossed.options.challenge,options)}),{code:'DEVICE_KEY_INVALID'})
   assert.equal(f.keys.length,1)
   await f.service.remove(f.request,{id:key.key.id,currentPassword:'synthetic-device-password'})
   assert.equal(f.keys.length,0)
 }
 for(const hostname of ['evil.test','sub.nav.cristsau.cn','nav.cristsau.cn.evil.test','__proto__']) {
   const request={hostname,headers:{origin:`https://${hostname}`}}
   assert.equal(deviceKeysAvailable(request),false)
   assert.throws(()=>requireDeviceKeyOrigin(request),{code:'DEVICE_KEY_UNAVAILABLE'})
 }
 for(const origin of ['https://nav.skrskr.net','http://nav.cristsau.cn','https://nav.cristsau.cn:443','null',undefined])
   assert.throws(()=>requireDeviceKeyOrigin({hostname:'nav.cristsau.cn',headers:{origin}}),{code:'DEVICE_KEY_ORIGIN'})
})

test('copied flow cookie cannot redeem the other-domain registration challenge',async()=>{
 const f=fixture(),a=authenticator(),other=DEVICE_KEY_SITES[1]
 const begin=await f.service.registerOptions(f.request,f.reply,{currentPassword:'synthetic-device-password',name:'合成设备'})
 const request={...f.request,hostname:other.rpId,headers:{origin:other.origin}}
 await assert.rejects(f.service.registerVerify(request,f.reply,{challengeId:begin.challengeId,response:a.register(begin.options.challenge,{origin:other.origin,rp:other.rpId})}),{code:'DEVICE_KEY_INVALID'})
 assert.equal(f.keys.length,0);assert.equal(f.challenges.size,1)
 await f.service.registerVerify(f.request,f.reply,{challengeId:begin.challengeId,response:a.register(begin.options.challenge)})
})
test('registration requires current password; old version, wrong origin and credential changes fail closed',async()=>{
 const f=fixture(),a=authenticator()
 await assert.rejects(f.service.registerOptions(f.request,f.reply,{currentPassword:'wrong',name:'test'}),{code:'DEVICE_KEY_REAUTH_REQUIRED'})
 const enrollment=await f.service.registerOptions(f.request,f.reply,{currentPassword:'synthetic-device-password',name:'test'})
 f.user.auth_version='4'
 await assert.rejects(f.service.registerVerify(f.request,f.reply,{challengeId:enrollment.challengeId,response:a.register(enrollment.options.challenge)}),{code:'DEVICE_KEY_INVALID'})
 assert.equal(f.keys.length,0)
 const login=await f.service.loginOptions(f.request,f.reply,{})
 f.user.auth_changed_at=new Date(Date.now()+1000)
 await assert.rejects(f.service.loginVerify(f.request,f.reply,{challengeId:login.challengeId,response:a.login(login.options.challenge)}),{code:'DEVICE_KEY_INVALID'})
 await assert.rejects(f.service.loginOptions({...f.request,headers:{origin:'https://nav.cristsau.cn'}},f.reply,{}),{code:'DEVICE_KEY_ORIGIN'})
})
