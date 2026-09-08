import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes} from 'node:crypto'
import {syntheticAuthenticator as authenticator} from './helpers/deviceKeyAuthenticator.js'
import {createDeviceKeyService,DEVICE_KEY_ORIGIN,DEVICE_KEY_RP_ID,deviceKeyUserHandle,sanitizedTransports} from '../src/lib/deviceKeys.js'
import {config} from '../src/config.js'
import {hashPassword} from '../src/lib/auth.js'
const previous={deviceKeysEnabled:config.deviceKeysEnabled,rateLimitKeySecret:config.rateLimitKeySecret}
let passwordHash
before(async()=>{config.deviceKeysEnabled=true;config.rateLimitKeySecret=randomBytes(32).toString('hex');passwordHash=await hashPassword('synthetic-device-password')})
after(()=>Object.assign(config,previous))
const userId='11111111-1111-4111-8111-111111111111'
function fixture() {
 const user={id:userId,username:'synthetic-device-owner',status:'approved',role:'user',auth_version:'3',auth_changed_at:new Date(0),password_hash:passwordHash}
 const statements=[],keys=[],challenges=new Map()
 let serial=0
 const client={query:async(sql,p=[])=>{
   statements.push({sql,p})
   const rows=value=>({rows:Array.isArray(value)?value:[value],rowCount:Array.isArray(value)?value.length:1})
   if(sql.startsWith('SELECT * FROM users') || sql.includes('SELECT u.*'))return rows(user)
   if(sql.startsWith('SELECT id FROM sessions'))return rows({id:'session-1'})
   if(sql.startsWith('SELECT credential_id,transports'))return rows(keys)
   if(sql.includes('SELECT COUNT(*)'))return rows({count:keys.length})
   if(sql.startsWith('INSERT INTO auth_device_key_challenges')){
     const register=sql.includes("VALUES('register'")
     const id=`challenge-${++serial}`,value={id,kind:register?'register':'login',challenge_digest:p[0],flow_digest:p[1],origin:p[2],created_at:new Date(),credential_version:register?p[5]:null,label:register?p[6]:null,trust_device:register?false:p[3]}
     challenges.set(id,value);return rows(value)
   }
   if(sql.startsWith('DELETE FROM auth_device_key_challenges') && sql.includes('WHERE id=$1')){
     const value=challenges.get(p[0]);if(!value || value.flow_digest!==p[1])return rows([])
     challenges.delete(p[0]);return rows(value)
   }
   if(sql.startsWith('INSERT INTO auth_device_keys')) {
     const value={id:'key-1',user_id:p[0],credential_id:p[1],public_key:p[2],counter:p[3],label:p[4],transports:JSON.parse(p[5]),device_type:p[6],backed_up:p[7],rp_id:DEVICE_KEY_RP_ID}
     keys.push(value);return rows(value)
   }
   if(sql.startsWith('SELECT * FROM auth_device_keys'))return rows(keys.filter(k=>k.credential_id===p[0] && k.user_id===p[1]))
   if(sql.startsWith('UPDATE auth_device_keys SET counter')){keys[0].counter=p[1];return rows([])}
   if(sql.startsWith('INSERT INTO sessions'))return rows({id:'new-session'})
   return rows([])
 }}
 const cookies={},request={hostname:DEVICE_KEY_RP_ID,headers:{origin:DEVICE_KEY_ORIGIN},cookies,currentUser:user,session:{id:'session-1'}}
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
   f.keys.push({id:'key-1',user_id:userId,credential_id:a.id,public_key:a.publicKey,counter:1,transports:['internal']})
   const login=await f.service.loginOptions(f.request,f.reply,{trustDevice:false})
   const body={challengeId:login.challengeId,response:a.login(patch.challenge || login.options.challenge,{counter:2,...patch})}
   await assert.rejects(f.service.loginVerify(f.request,f.reply,body),{code:'DEVICE_KEY_INVALID'},label)
   assert.equal(f.statements.some(s=>s.sql.startsWith('INSERT INTO sessions')),false,label)
   assert.equal(f.challenges.size,0,'failed cryptographic proof is consumed')
 }
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
