// UI-only checks against a backend-mode preview; every API response is a synthetic fixture.
// Requires Playwright module path and browser executable supplied by the local runtime.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {gzipSync} from 'node:zlib'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const origin=process.env.NAV_UI_PREVIEW || 'http://127.0.0.1:4178'
assert.equal(new URL(origin).hostname,'127.0.0.1','UI preview must remain local')
const output=await mkdtemp(path.join(tmpdir(),'nav-auth-ui-'))
const browser=await chromium.launch({executablePath:process.env.NAV_BROWSER_PATH,headless:true})
const results=[],errors=[],loadedJs=new Set()
try {
 for(const width of [320,375,390,768,1024,1440])for(const theme of ['light','dark']) {
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'})
  const page=await context.newPage()
  page.on('pageerror',error=>errors.push(error.message))
  page.on('response',r=>{if(new URL(r.url()).pathname.endsWith('.js'))loadedJs.add(new URL(r.url()).pathname)})
  let otpAvailable=true,resetAvailable=true
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url()).pathname
   let body={},status=200
   if(url==='/api/auth/capabilities')body={password:true,emailLogin:otpAvailable,emailPasswordReset:resetAvailable,emailBinding:true,passkey:false}
   else if(url==='/api/auth/session')body={user:null}
   else if(url==='/api/auth/register/config')body={emailVerificationEnabled:true,emailRequired:true}
   else if(url.includes('oauth') && url.endsWith('/config'))body={providers:{google:{enabled:true},wechat:{enabled:false}}}
   else if(url.endsWith('/request')){status=202;body={challengeId:'11111111-1111-4111-8111-111111111111',expiresIn:300,resendAfter:60,message:'如果该邮箱可用于此操作，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。'}}
   else if(url.endsWith('/verify')){status=400;body={code:'AUTH_EMAIL_CODE_INVALID'}}
   else if(url.endsWith('/confirm'))body={ok:true,signInRequired:true}
   else if(url.endsWith('/login')){status=401;body={error:'用户名或密码不正确'}}
   else if(url.includes('settings'))body={value:null,settings:{}}
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
  })
  await page.goto(`${origin}/auth`,{waitUntil:'networkidle'})
  await page.getByRole('button',{name:'获取验证码',exact:true}).waitFor()
  assert.equal(await page.getByText('使用 Google 登录',{exact:true}).count(),1,'Google must remain available in OTP mode')
  assert.equal(await page.getByText(/Passkey|通行密钥/i).count(),0)
  async function layout(stage) {
   const measured=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,small:[...document.querySelectorAll('button,input,a')].filter(e=>e.getClientRects().length && !e.disabled && e.getBoundingClientRect().height<43.5).map(e=>e.tagName),dark:document.documentElement.classList.contains('dark')}))
   assert.equal(measured.overflow,false,`${width}/${theme}/${stage} overflow`)
   assert.deepEqual(measured.small,[],`${width}/${theme}/${stage} touch size`)
   results.push({width,theme,stage,...measured})
  }
  await layout('email-request')
  if(width===1440 || width===390)await page.screenshot({path:path.join(output,`auth-${width}-${theme}.png`),fullPage:true})
  await page.getByLabel('绑定邮箱',{exact:true}).fill('synthetic@example.test')
  await page.getByRole('button',{name:'获取验证码',exact:true}).click()
  const code=page.getByLabel('6 位验证码',{exact:true})
  await code.waitFor()
  assert.equal(await code.evaluate(e=>document.activeElement===e),true,'OTP focus')
  await code.fill('000123')
  await page.getByRole('button',{name:'验证并登录',exact:true}).click()
  await page.getByRole('alert').waitFor()
  await layout('invalid-code')
  const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))
  assert.equal(storage.includes('000123'),false)
  assert.equal(storage.includes('synthetic@example.test'),false)
  await page.getByRole('button',{name:'修改邮箱',exact:true}).click()
  assert.equal(await page.getByRole('button',{name:/秒后重新申请/}).isDisabled(),true)
  await page.getByRole('button',{name:'忘记密码？通过邮箱重设',exact:true}).click()
  await page.getByLabel('绑定邮箱',{exact:true}).fill('synthetic@example.test')
  await page.getByRole('button',{name:'获取验证码',exact:true}).click()
  await page.getByLabel('6 位验证码',{exact:true}).fill('000123')
  await page.getByLabel('新密码',{exact:true}).fill('synthetic-password-long')
  await page.getByLabel('确认新密码',{exact:true}).fill('synthetic-password-long')
  await page.getByRole('button',{name:'确认修改并退出全部设备',exact:true}).click()
  await page.getByRole('heading',{name:'密码已重设',exact:true}).waitFor()
  assert.equal(await page.locator('input[type=password]').count(),0)
  await page.getByRole('button',{name:'返回账号密码登录',exact:true}).click()
  await page.getByLabel('用户名',{exact:true}).waitFor()
  await layout('password-fallback')
  otpAvailable=false;resetAvailable=false
  await page.reload({waitUntil:'networkidle'})
  await page.getByLabel('用户名',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'邮箱验证码',exact:true}).isDisabled(),true)
  assert.equal(await page.getByRole('button',{name:'忘记密码？通过邮箱重设',exact:true}).count(),0)
  await context.close()
 }
 assert.deepEqual(errors,[],'browser runtime exceptions')
 const jsBytes=[]
 for(const file of loadedJs) {
  const buffer=await readFile(path.resolve('app/dist',`.${file}`))
  jsBytes.push({file,gzipBytes:gzipSync(buffer).length})
 }
 const report={scope:'mocked-API UI only; not SMTP, live authentication, real iPhone or production acceptance',checks:results.length,results,jsBytes,initialRouteGzipBytes:jsBytes.reduce((n,r)=>n+r.gzipBytes,0),errors}
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify({status:'PASS',checks:results.length,initialRouteGzipBytes:report.initialRouteGzipBytes,output}))
} finally {await browser.close()}
