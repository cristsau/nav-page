// Component-level browser check: Vite backend-mode dev server, synthetic API only.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const origin='http://127.0.0.1:4179'
const browser=await chromium.launch({executablePath:process.env.NAV_BROWSER_PATH,headless:true})
try {
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'})
 const errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 let allowed=false,businessCalls=0
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()).pathname
  let body={},status=200
  if(url==='/api/auth/session')body={user:null}
  else if(url==='/api/auth/capabilities')body={emailLogin:false,emailPasswordReset:false}
  else if(url==='/api/auth/oauth/config')body={providers:{google:{enabled:false},wechat:{enabled:false}}}
  else if(url==='/api/migration/export-cloud') {
    businessCalls++;status=allowed?200:403;body=allowed?{ok:true}:{code:'PASSWORD_REAUTH_REQUIRED'};allowed=false
  } else if(url==='/api/auth/action/reauth') {
    allowed=route.request().postDataJSON().currentPassword==='synthetic-reauth-password'
    status=allowed?200:403;body=allowed?{ok:true}:{code:'AUTH_EMAIL_REAUTH_REQUIRED'}
  }
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
 })
 await page.goto(`${origin}/auth`,{waitUntil:'networkidle'})
 await page.getByLabel('用户名',{exact:true}).waitFor()
 await page.evaluate(()=>{
  const trigger=document.createElement('button');trigger.id='synthetic-export-trigger';trigger.textContent='Synthetic export'
  trigger.onclick=async()=>{
    window.testOutcome='pending'
    try {const {apiRequest}=await import('/src/shared/services/apiClient.js');await apiRequest('/migration/export-cloud');window.testOutcome='success'}
    catch {window.testOutcome='cancelled'}
  }
  document.querySelector('.auth-card').append(trigger)
 })
 const trigger=page.locator('#synthetic-export-trigger')
 await trigger.click()
 const dialog=page.getByRole('dialog',{name:'确认是你本人'})
 await dialog.waitFor()
 const password=dialog.getByLabel('当前密码',{exact:true})
 await page.waitForFunction(()=>document.activeElement?.type==='password')
 await password.fill('wrong-synthetic-password')
 await dialog.getByRole('button',{name:'验证并继续',exact:true}).click()
 await dialog.getByRole('alert').waitFor()
 assert.equal(await password.inputValue(),'')
 assert.equal(businessCalls,1)
 await password.fill('synthetic-reauth-password')
 await dialog.getByRole('button',{name:'验证并继续',exact:true}).click()
 await page.waitForFunction(()=>window.testOutcome==='success')
 assert.equal(businessCalls,2)
 await page.waitForFunction(()=>document.activeElement?.id==='synthetic-export-trigger')
 await trigger.click();await dialog.waitFor()
 await password.fill('synthetic-reauth-password')
 await page.keyboard.press('Escape')
 await page.waitForFunction(()=>window.testOutcome==='cancelled')
 assert.equal(businessCalls,3,'cancel cannot retry export')
 await trigger.click();await dialog.waitFor()
 assert.equal(await password.inputValue(),'','cancelled password must not survive')
 for(let i=0;i<8;i++) {
   await page.keyboard.press('Tab')
   assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('[role=dialog]'))),true,'focus must stay inside dialog')
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
 const stored=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))
 assert.equal(stored.includes('synthetic-reauth-password'),false)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({status:'PASS',scope:'synthetic API component check',checks:['wrong-password-no-retry','one-use-retry','cancel-no-retry','password-cleared','focus-trap','focus-return','mobile-no-overflow','no-password-storage']}))
} finally {await browser.close()}
