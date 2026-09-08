// Local built Vue + virtual authenticator + synthetic API. No provider, personal profile or SMTP calls.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const require=createRequire(import.meta.url),apiRequire=createRequire(new URL('../api/package.json',import.meta.url))
const {chromium}=require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse}=await import(pathToFileURL(apiRequire.resolve('@simplewebauthn/server')).href)
const output=await mkdtemp(join(tmpdir(),'nav-pwa-device-ui-'))
const local='http://127.0.0.1:4178',origin='https://nav.skrskr.net',rpID='nav.skrskr.net'
const user={id:'11111111-1111-4111-8111-111111111111',username:'synthetic-ui-owner',role:'user',status:'approved'}
const browser=await chromium.launch({executablePath:process.env.NAV_BROWSER_PATH,headless:true,
  args:['--host-resolver-rules=MAP nav.skrskr.net 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost']})
const checks=[],errors=[]
try {
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'})
 const consoleErrors=[],requests=[]
 context.on('page',page=>{page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});page.on('requestfailed',r=>consoleErrors.push(`${new URL(r.url()).pathname}: ${r.failure()?.errorText}`))})
 let loggedIn=true,key=null,registrationOptions,authenticationOptions,trust=false,handoff='expired',launchObserved=false,completionCalls=0
 let guardEnabled=false,passwordCalls=0
 await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{get:()=>true,configurable:true}))
 await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url())
   requests.push({path:url.pathname,type:req.resourceType(),method:req.method()})
   if(url.origin==='https://challenges.cloudflare.com' && url.pathname==='/turnstile/v0/api.js')return route.fulfill({contentType:'application/javascript',body:`
     window.turnstile={widgets:new Map(),render(host,options){const id=this.widgets.size;const button=document.createElement('button');button.type='button';button.textContent='完成模拟安全验证';button.onclick=()=>options.callback('synthetic-proof-'+options.action);host.append(button);this.widgets.set(id,host);return id},reset(){},remove(id){this.widgets.get(id)?.replaceChildren();this.widgets.delete(id)}};
   `})
   if(url.origin!==origin)return route.abort()
   if(!url.pathname.startsWith('/api/')) {
     const response=await fetch(`${local}${url.pathname}${url.search}`,{redirect:'error'})
     return route.fulfill({status:response.status,contentType:response.headers.get('content-type') || 'text/plain',body:Buffer.from(await response.arrayBuffer())})
   }
   const path=url.pathname.slice(4),payload=req.postData()?req.headers()['content-type']?.includes('json')?req.postDataJSON():null:null
   let body={},status=200
   if(path==='/auth/session')body={user:loggedIn?user:null}
   else if(path==='/auth/capabilities')body={password:true,emailLogin:true,emailPasswordReset:true,emailBinding:true,passkey:false}
   else if(path==='/auth/bot-guard/config')body={enabled:guardEnabled,siteKey:guardEnabled?'synthetic-site':''}
   else if(path==='/auth/login') {
     passwordCalls++
     if(!payload.turnstileToken){status=403;body={code:'BOT_CHALLENGE_REQUIRED',error:'请先完成安全验证'}}
     else {assert.equal(payload.turnstileToken,'synthetic-proof-password_login');status=401;body={error:'合成账号密码不匹配'}}
   }
   else if(path==='/auth/registration/config')body={emailVerificationEnabled:true,emailRequired:true}
   else if(path==='/auth/oauth/config')body={pwaHandoff:true,providers:{google:{enabled:true},wechat:{enabled:false}}}
   else if(path==='/auth/device-keys/config')body={enabled:true,configured:true,origin,optional:true}
   else if(path==='/auth/device-keys')body={keys:key?[{id:'synthetic-key',name:'我的 iPhone',domain:rpID,createdAt:new Date().toISOString(),synced:false}]:[]}
   else if(path==='/auth/device-keys/register/options') {
     assert.equal(payload.currentPassword,'synthetic-ui-password')
     registrationOptions=await generateRegistrationOptions({rpName:'DOMO NAV',rpID,userID:Buffer.from(user.id),userName:user.username,attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required',authenticatorAttachment:'platform'}})
     body={options:registrationOptions,challengeId:'synthetic-registration'}
   } else if(path==='/auth/device-keys/register/verify') {
     const result=await verifyRegistrationResponse({response:payload.response,expectedChallenge:registrationOptions.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true})
     assert.equal(result.verified,true);key=result.registrationInfo.credential;body={key:{id:'synthetic-key'}}
   } else if(path==='/auth/device-keys/login/options') {
     trust=payload.trustDevice
     authenticationOptions=await generateAuthenticationOptions({rpID,userVerification:'required'})
     body={options:authenticationOptions,challengeId:'synthetic-login'}
   } else if(path==='/auth/device-keys/login/verify') {
     const result=await verifyAuthenticationResponse({response:payload.response,expectedChallenge:authenticationOptions.challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,credential:key})
     assert.equal(result.verified,true);loggedIn=true;body={user}
   } else if(path==='/auth/oauth/google/pwa/start') {handoff='pending';trust=payload.trustDevice;body={launch:'L'.repeat(43),expiresIn:600}}
   else if(path==='/auth/oauth/google/pwa/launch') {
     assert.equal(req.method(),'POST');assert.equal(new URLSearchParams(req.postData()).get('launch'),'L'.repeat(43));assert.equal(url.search,'');launchObserved=true
     // Synthetic provider approval, not a live Google callback.
     // Playwright interception does not re-route every HTTP redirect hop. A fresh
     // document navigation keeps this provider stand-in entirely inside the mock.
     handoff='ready';return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><script>location.replace("/auth/oauth-complete")</script>'})
   } else if(path==='/auth/oauth/pwa/status')body={state:handoff}
   else if(path==='/auth/oauth/pwa/complete') {assert.equal(handoff,'ready');completionCalls++;handoff='expired';loggedIn=true;body={user,returnTo:'/'}}
   else if(path==='/auth/oauth/pwa/cancel') {handoff='expired';body={ok:true}}
   else if(path==='/auth/sessions')body={sessions:[{id:'synthetic-session',current:true,userAgent:'Synthetic Safari',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+14*86400000).toISOString()}]}
   else if(path==='/auth/recovery-codes/status')body={activeCount:10,usedCount:0}
   else if(path==='/auth/account/email')body={maskedEmail:'s***@example.test',verified:true,emailLogin:true,emailPasswordReset:true,emailBinding:true}
   else if(path==='/auth/oauth/identities')body={identities:[]}
   else if(path==='/groups')body={groups:[{id:'synthetic-group',name:'日常',icon:'folder',order:0}]}
   else if(path==='/bookmarks')body={bookmarks:[{id:'synthetic-bookmark',groupId:'synthetic-group',title:'设计灵感',url:'https://example.test',order:0,tags:['设计']} ]}
   else if(path==='/notes')body={notes:[]}
   else if(path.includes('settings'))body={value:null,settings:{}}
   else if(path.includes('notifications'))body={notifications:[],unreadCount:0}
   else if(path.includes('search-engines'))body={engines:[]}
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
 })
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
 const cdp=await context.newCDPSession(page)
 await cdp.send('WebAuthn.enable')
 await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}})
 await page.goto(`${origin}/settings?category=security`,{waitUntil:'networkidle'})
 await page.getByRole('button',{name:'添加通行密钥',exact:true}).click()
 await page.getByLabel('设备名称',{exact:true}).fill('我的 iPhone')
 await page.getByLabel('验证当前账号密码',{exact:true}).fill('synthetic-ui-password')
 await page.getByRole('button',{name:'验证并添加',exact:true}).click()
 await page.getByText('快捷登录已添加。下次需要登录时，可以使用设备验证。',{exact:true}).waitFor()
 assert.ok(key);assert.equal(await page.locator('.device-key-form input[type=password]').count(),0)
 await page.locator('.device-key-settings').scrollIntoViewIfNeeded()
 await page.screenshot({path:join(output,'iphone-security.png'),fullPage:false})
 checks.push('virtual-platform-resident-key-enrollment-real-cryptographic-verification-and-secret-clearing')
 loggedIn=false
 await page.goto(`${origin}/auth`,{waitUntil:'networkidle'})
 await page.getByRole('button',{name:/快捷登录 Face ID/}).waitFor()
 await page.screenshot({path:join(output,'iphone-login.png'),fullPage:true})
 await page.getByLabel(/信任此设备/).check()
 await page.getByRole('button',{name:/快捷登录 Face ID/}).click()
 await page.waitForURL(`${origin}/`);assert.equal(loggedIn,true);assert.equal(trust,true)
 await page.locator('[data-bookmark-id="synthetic-bookmark"]').waitFor()
 await page.screenshot({path:join(output,'iphone-navigation.png'),fullPage:false})
 checks.push('virtual-device-login-real-signature-private-device-opt-in-and-home-return')
 loggedIn=false;handoff='expired'
 await page.goto(`${origin}/auth`,{waitUntil:'networkidle'})
 await page.getByLabel(/信任此设备/).check()
 const popupPromise=context.waitForEvent('page')
 await page.getByRole('button',{name:'使用 Google 登录',exact:true}).click()
 const popup=await popupPromise
 await popup.waitForURL(`${origin}/auth/oauth-complete`)
 try {await popup.getByRole('heading',{name:'验证已完成',exact:true}).waitFor()}
 catch(error){await popup.screenshot({path:join(output,'return-failure.png'),fullPage:true});console.log(JSON.stringify({output,errors,consoleErrors:consoleErrors.slice(-10),requests:requests.slice(-15),popupUrl:popup.url(),stage:'popup-render'}));throw error}
 assert.equal(launchObserved,true);assert.equal(popup.url().includes('LLLL'),false)
 await popup.screenshot({path:join(output,'iphone-return.png'),fullPage:true})
 await popup.close();await page.bringToFront();await page.waitForURL(`${origin}/`)
 assert.equal(completionCalls,1);assert.equal(trust,true)
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))
 assert.equal(/LLLL|synthetic-ui-password/.test(storage),false)
 checks.push('synchronous-popup-post-only-launch-return-page-original-app-resume-no-secret-storage')
 loggedIn=false;guardEnabled=true
 await page.goto(`${origin}/auth`,{waitUntil:'networkidle'})
 await page.getByRole('button',{name:'账号密码',exact:true}).click()
 await page.getByLabel('用户名',{exact:true}).fill('synthetic-owner')
 await page.getByLabel('密码',{exact:true}).fill('synthetic-ui-password')
 await page.locator('form .auth-submit').click()
 await page.getByRole('button',{name:'完成模拟安全验证',exact:true}).waitFor()
 assert.equal(passwordCalls,1)
 await page.locator('form .auth-submit').click();assert.equal(passwordCalls,1,'missing challenge is blocked before password resubmission')
 await page.getByRole('button',{name:'完成模拟安全验证',exact:true}).click()
 await page.locator('form .auth-submit').click()
 await page.getByRole('alert').filter({hasText:'合成账号密码不匹配'}).waitFor();assert.equal(passwordCalls,2)
 await page.locator('form .auth-submit').click();assert.equal(passwordCalls,2,'consumed token cannot be submitted again')
 checks.push('risk-triggered-challenge-widget-action-missing-and-consumed-token-guard')
 assert.deepEqual(errors,[])
 await writeFile(join(output,'report.json'),JSON.stringify({scope:'local mocked API and virtual authenticator only; not real iPhone/Google/PostgreSQL/production',checks,errors},null,2))
 console.log(JSON.stringify({status:'PASS',checks,output}))
 await context.close()
} finally {await browser.close()}
