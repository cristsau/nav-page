import test from 'node:test'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'
import {parseAuthEmailKeys,authEmailKeyVersion,encryptAuthPayload,decryptAuthPayload,emailCodeMac,equalDigest,newEmailCode,proofDigest} from '../src/lib/authEmailCrypto.js'
import {actionRequestPath,passwordProtectedAction} from '../src/lib/authActionProof.js'
import {classifyAuthSmtpFailure} from '../src/lib/authEmailDelivery.js'
import {validateNewPassword,hashPassword,verifyPassword} from '../src/lib/auth.js'
import {createApp} from '../src/app.js'
import {config} from '../src/config.js'

const keyText=()=>JSON.stringify({version:1,hmacKey:randomBytes(32).toString('hex'),encryptionKey:randomBytes(32).toString('hex')})

test('key rotation accepts only one previous version for at most five minutes',()=>{
 const now=Date.now(),previous={...JSON.parse(keyText()),rotatedAt:new Date(now).toISOString(),acceptUntil:new Date(now+300000).toISOString()}
 const value={...JSON.parse(keyText()),version:2,previous}
 const keys=parseAuthEmailKeys(JSON.stringify(value))
 assert.equal(authEmailKeyVersion(keys,1,now+299999).version,1)
 assert.throws(()=>authEmailKeyVersion(keys,1,now+300000))
 assert.throws(()=>authEmailKeyVersion(keys,0,now))
 assert.throws(()=>parseAuthEmailKeys(JSON.stringify({...value,previous:{...previous,acceptUntil:new Date(now+300001).toISOString()}})))
 assert.throws(()=>parseAuthEmailKeys(JSON.stringify({...value,previous:{...previous,previous}})))
})

test('sensitive action allowlist matches actual routes, encoding cannot evade it',()=>{
 for(const [method,path] of [['GET','/migration/export-cloud'],['GET','/migration/export-cloud-stream'],['GET','/migration/restore/safety-backup'],['PUT','/admin/telegram-config'],['POST','/admin/telegram-config/test'],['PUT','/admin/integrations/system-mail'],['POST','/admin/oauth-integrations/identity/google/test']])assert.equal(passwordProtectedAction(method,path),true,path)
 assert.equal(passwordProtectedAction('GET','/admin/auth-email/status'),false)
 assert.equal(passwordProtectedAction('GET','/navigation'),false)
 const path=actionRequestPath({url:'/api/migration/%65xport-cloud/?format=json'})
 assert.equal(passwordProtectedAction('GET',path),true)
 assert.equal(actionRequestPath({url:'/api/%bad'}),'')
})
test('AEAD binds job context, key version and integrity; independent keys required',()=>{
 const keys=parseAuthEmailKeys(keyText()),context=`job:${randomUUID()}`
 const sealed=encryptAuthPayload({code:'001234',recipient:'synthetic@example.test'},context,keys)
 assert.equal(sealed.includes('001234'),false)
 assert.deepEqual(decryptAuthPayload(sealed,context,keys),{code:'001234',recipient:'synthetic@example.test'})
 assert.throws(()=>decryptAuthPayload(sealed,`${context}x`,keys))
 assert.throws(()=>decryptAuthPayload(sealed,context,{...keys,version:2}))
 assert.throws(()=>decryptAuthPayload(sealed,context,parseAuthEmailKeys(keyText())))
 const p=sealed.split('.');p[1]=Buffer.alloc(16).toString('base64url')
 assert.throws(()=>decryptAuthPayload(p.join('.'),context,keys))
 assert.throws(()=>parseAuthEmailKeys(JSON.stringify({version:1,hmacKey:'ab'.repeat(32),encryptionKey:'AB'.repeat(32)})))
})
test('OTP MAC binds every identity dimension and preserves leading zero',()=>{
 const keys=parseAuthEmailKeys(keyText())
 const c={id:randomUUID(),user_id:randomUUID(),purpose:'login',email_key_digest:proofDigest('test'),origin:'https://a.example.test',flow_digest:proofDigest('flow')}
 const mac=emailCodeMac(c,'001234',keys)
 assert.equal(equalDigest(mac,emailCodeMac(c,'001234',keys)),true)
 for(const key of Object.keys(c))assert.equal(equalDigest(mac,emailCodeMac({...c,[key]:`${c[key]}x`},'001234',keys)),false,key)
 assert.equal(equalDigest(mac,emailCodeMac(c,'1234',keys)),false)
 assert.equal(equalDigest(mac,'invalid'),false)
 for(let i=0;i<1000;i++)assert.match(newEmailCode(),/^\d{6}$/)
})
test('password boundaries count Unicode without trimming and preserve legacy verification',async()=>{
 assert.equal(validateNewPassword('a'.repeat(14)).valid,false)
 assert.equal(validateNewPassword('𠮷'.repeat(15)).valid,true)
 assert.equal(validateNewPassword('𠮷'.repeat(1024)).valid,true)
 assert.equal(validateNewPassword('𠮷'.repeat(1025)).valid,false)
 const value='  spaced password  '
 const hash=await hashPassword(value)
 assert.equal(await verifyPassword(value,hash),true)
 assert.equal(await verifyPassword(value.trim(),hash),false)
 const legacy=await hashPassword('legacy-short')
 assert.equal(await verifyPassword('legacy-short',legacy),true)
})
test('SMTP explicit rejection, pre-DATA failures and uncertain DATA differ',()=>{
 assert.equal(classifyAuthSmtpFailure({responseCode:550}).state,'failed')
 assert.equal(classifyAuthSmtpFailure({responseCode:451}).state,'pending')
 assert.equal(classifyAuthSmtpFailure({command:'CONN',code:'ETIMEDOUT'}).state,'pending')
 assert.equal(classifyAuthSmtpFailure({command:'DATA',code:'ETIMEDOUT'}).state,'unknown')
 assert.equal(classifyAuthSmtpFailure({}).state,'unknown')
})
test('disabled capabilities fail closed and strict schema rejects extra data without DB access',async()=>{
 const old=[config.emailLoginEnabled,config.emailPasswordResetEnabled]
 config.emailLoginEnabled=false;config.emailPasswordResetEnabled=false
 const app=createApp()
 try {
   const response=await app.inject('/api/auth/capabilities')
   assert.equal(response.statusCode,200)
   assert.equal(response.json().emailLogin,false)
   assert.equal(response.headers['cache-control'],'no-store')
   const invalid=await app.inject({method:'POST',url:'/api/auth/email-login/request',headers:{origin:config.corsOrigin.split(',')[0]},payload:{email:'synthetic@example.test',userId:randomUUID()}})
   assert.equal(invalid.statusCode,400)
 } finally {await app.close();[config.emailLoginEnabled,config.emailPasswordResetEnabled]=old}
})
