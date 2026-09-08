// Built Vue + synthetic authenticated admin only. All browser requests are intercepted.
// No production accounts, database or provider calls. Startup config saves stay in this fixture.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const require = createRequire(import.meta.url)
const {chromium} = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const local = process.env.NAV_UI_PREVIEW || 'http://127.0.0.1:4178'
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(local), 'preview must be local')
const main = 'https://nav.skrskr.net', alternate = 'https://nav.cristsau.cn'
const output = await mkdtemp(join(tmpdir(), 'nav-settings-mobile-ui-'))
const browser = await chromium.launch({executablePath:process.env.NAV_BROWSER_PATH, headless:true,
  args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']})
const checks = [], pageErrors = [], unexpected = []
const timestamp = '2026-09-08T09:00:00.000Z'
const user = {id:'11111111-1111-4111-8111-111111111111',username:'synthetic-ui-owner',role:'admin',status:'approved'}
const longName = '我的随身设备-' + 'VeryLongSyntheticDeviceName'.repeat(3)
async function enlargeText(page, scale) {
  await page.evaluate(scale => {
    window.__uiEnlargedElements ??= new WeakSet()
    const items=[...document.querySelectorAll('.settings-page *')]
      .filter(el=>!window.__uiEnlargedElements.has(el))
      .map(el=>[el,parseFloat(getComputedStyle(el).fontSize)])
    for(const [el,size] of items){el.style.fontSize=`${size*scale}px`;window.__uiEnlargedElements.add(el)}
  },scale)
}
async function fixture({width=390, theme='light', origin=main, supported=true, state='enabled', scale=1, keyName=longName}={}) {
  const context = await browser.newContext({viewport:{width,height:844},colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'})
  const mock = {state,configReads:0,keyReads:0,mutations:0}
  await context.addInitScript(({supported}) => {
    Object.defineProperty(navigator,'standalone',{get:()=>true,configurable:true})
    Object.defineProperty(window,'PublicKeyCredential',{value:class {
      static async isUserVerifyingPlatformAuthenticatorAvailable(){return supported}
    },configurable:true})
  },{supported})
  await context.route('**/*', async route => {
    const request=route.request(), url=new URL(request.url())
    if(url.origin!==origin){unexpected.push(url.origin+url.pathname);return route.abort()}
    if(!url.pathname.startsWith('/api/')) {
      const response=await fetch(local+url.pathname+url.search,{redirect:'error'})
      return route.fulfill({status:response.status,contentType:response.headers.get('content-type') || 'text/plain',body:Buffer.from(await response.arrayBuffer())})
    }
    // Existing startup theme/config normalization may save appConfig. It never leaves this mock.
    if(request.method()==='PUT' && url.pathname==='/api/settings/appConfig')return route.fulfill({json:{ok:true}})
    if(request.method()!=='GET') {
      mock.mutations++;unexpected.push(request.method()+' '+url.pathname)
      return route.fulfill({status:403,json:{error:'Synthetic read-only fixture'}})
    }
    const path=url.pathname.slice(4)
    let body={}, status=200
    if(path==='/auth/session')body={user}
    else if(path==='/auth/capabilities')body={password:true,emailLogin:true,emailBinding:true,emailPasswordReset:true,passkey:false}
    else if(path==='/auth/device-keys/config') {
      mock.configReads++
      if(mock.state==='config-error'){status=503;body={error:'Synthetic temporary failure'}}
      else if(mock.state==='malformed')body={enabled:'true',configured:'true'}
      else body={enabled:mock.state!=='disabled',configured:mock.state!=='disabled',origin,optional:true}
    } else if(path==='/auth/device-keys') {
      mock.keyReads++
      if(mock.state==='list-error'){status=503;body={error:'Synthetic temporary failure'}}
      else if(mock.state==='list-malformed')body={keys:null}
      else body={keys:[{id:'synthetic-key',name:keyName,synced:true,lastUsedAt:timestamp}]}
    } else if(path==='/auth/sessions')body={sessions:[{id:'synthetic-session',current:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Synthetic Safari/604.1',ipAddress:'2001:db8:1234:5678:9012:3456:7890:abcd',createdAt:timestamp,lastSeenAt:timestamp,expiresAt:'2026-10-08T09:00:00.000Z'}]}
    else if(path==='/auth/recovery-codes/status')body={configured:false,activeCodeCount:0,generatedAt:null}
    else if(path==='/auth/account/email')body={maskedEmail:'s***@example.test',verified:true,emailBinding:true,emailPasswordReset:true}
    else if(path==='/auth/oauth/config')body={providers:{google:{enabled:true},wechat:{enabled:false}}}
    else if(path==='/auth/oauth/identities')body={identities:[{id:'synthetic-identity',provider:'google',createdAt:timestamp,lastUsedAt:timestamp}]}
    else if(path.includes('settings'))body={value:null,settings:{}}
    else if(path.includes('notifications'))body={notifications:[],unreadCount:0}
    else if(path.includes('search-engines'))body={engines:[]}
    else if(path==='/groups')body={groups:[]}
    else if(path==='/bookmarks')body={bookmarks:[]}
    else if(path==='/notes')body={notes:[]}
    else {unexpected.push(path);status=404;body={error:'Unmocked endpoint'}}
    await route.fulfill({status,json:body})
  })
  const page=await context.newPage()
  page.on('pageerror', e=>pageErrors.push(e.message))
  await page.goto(origin+'/settings?category=security',{waitUntil:'networkidle'})
  await page.locator('.device-key-settings[aria-busy="false"]').waitFor()
  await page.locator('.session-card').waitFor()
  await page.evaluate(async () => {await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))})
  assert.equal(await page.locator('.category-tabs button').count(),7,'admin fixture must exercise all tabs')
  if(scale!==1) {
    // Stress text-only enlargement without increasing card/input widths; not an iOS Dynamic Type claim.
    await enlargeText(page,scale)
  }
  return {context,page,mock}
}

async function verifyGeometry(page, label, mobile=true) {
  const problems=await page.evaluate(mobile => {
    const problems=[], shown=el=>!!el.getClientRects().length
    if(document.documentElement.scrollWidth>innerWidth+1)problems.push('page overflow')
    const tabs=document.querySelector('.category-tabs')
    if(mobile) {
      for(const button of tabs.querySelectorAll('button')) {
        const span=button.querySelector('span'), range=document.createRange();range.selectNodeContents(span)
        const rect=button.getBoundingClientRect(), text=range.getBoundingClientRect()
        if(getComputedStyle(span).whiteSpace!=='nowrap' || text.height>parseFloat(getComputedStyle(span).lineHeight)+1)problems.push('wrapped tab '+span.textContent)
        if(text.left<rect.left || text.right>rect.right)problems.push('tab text outside button')
        if(rect.height<44)problems.push('small tab touch target')
      }
      if(innerWidth<=430 && tabs.scrollWidth<=tabs.clientWidth)problems.push('tabs unexpectedly squeezed')
    }
    for(const el of document.querySelectorAll('.security-section button,.security-section input,.device-key-link')) {
      if(!shown(el))continue
      const rect=el.getBoundingClientRect(), style=getComputedStyle(el)
      if(rect.height<43.5)problems.push('small touch target '+el.className)
      // A long editable input value should scroll inside the input, not enlarge its border.
      if(el.tagName!=='INPUT' && el.clientWidth && el.scrollWidth>el.clientWidth+1)problems.push('control overflow '+el.className)
      if(el.tagName==='INPUT') {
        const parent=el.parentElement.getBoundingClientRect()
        if(rect.left<parent.left-1 || rect.right>parent.right+1)problems.push('input border outside label')
      }
      if(el.tagName==='INPUT' && parseFloat(style.fontSize)<16)problems.push('input font below 16px')
      if(el.tagName!=='INPUT') {
        const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT)
        while(walker.nextNode()) {
          if(!walker.currentNode.textContent.trim())continue
          const range=document.createRange();range.selectNodeContents(walker.currentNode)
          for(const text of range.getClientRects())if(text.left<rect.left-1 || text.right>rect.right+1 || text.top<rect.top-1 || text.bottom>rect.bottom+1)problems.push('text outside control '+el.className)
        }
      }
    }
    for(const el of document.querySelectorAll('.security-section,.security-block,.device-key-settings,.account-form,.oauth-card,.email-auth__section')) {
      if(shown(el) && el.scrollWidth>el.clientWidth+1)problems.push('card overflow '+el.className)
    }
    return [...new Set(problems)]
  },mobile)
  assert.deepEqual(problems,[],label)
}

try {
  for(const width of [320,375,390,430,768,1440])for(const theme of ['light','dark']) {
    const label=`${width}-${theme}`, f=await fixture({width,theme}), {page}=f
    assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('dark')),theme==='dark')
    await verifyGeometry(page,label,width<=820)
    if(width<=430) {
      const activeVisible=await page.locator('.category-tabs').evaluate(el=>{const a=el.querySelector('[aria-current="page"]').getBoundingClientRect(),r=el.getBoundingClientRect();return a.left>=r.left && a.right<=r.right})
      assert.ok(activeVisible,'selected security tab is visible after deep link')
    }
    await page.getByRole('button',{name:'添加通行密钥',exact:true}).click()
    await page.getByLabel('设备名称',{exact:true}).fill(longName)
    await page.getByLabel('验证当前账号密码',{exact:true}).fill('synthetic-cancel-only')
    await verifyGeometry(page,label+'-enrollment',width<=820)
    await page.locator('.device-key-form').getByRole('button',{name:'取消',exact:true}).click()
    await page.getByRole('button',{name:'添加通行密钥',exact:true}).click()
    assert.equal(await page.getByLabel('验证当前账号密码',{exact:true}).inputValue(),'')
    await page.locator('.device-key-form').getByRole('button',{name:'取消',exact:true}).click()
    if([390,1440].includes(width)) {
      await page.locator('.device-key-settings').scrollIntoViewIfNeeded()
      await page.screenshot({path:join(output,`${label}-quick-login.png`)})
      await page.locator('.account-form').last().scrollIntoViewIfNeeded()
      await page.screenshot({path:join(output,`${label}-password.png`)})
      await page.locator('.session-card').scrollIntoViewIfNeeded()
      await page.screenshot({path:join(output,`${label}-sessions.png`)})
    }
    assert.equal(f.mock.mutations,0)
    checks.push(label+'-layout-and-form-cancel');await f.context.close()
  }
  for(const width of [320,390]) {
    const f=await fixture({width,scale:1.5})
    await verifyGeometry(f.page,`${width}-150-percent-text`)
    await f.page.getByRole('button',{name:'添加通行密钥',exact:true}).click()
    await enlargeText(f.page,1.5)
    assert.equal(await f.page.getByLabel('设备名称',{exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),24)
    await verifyGeometry(f.page,`${width}-150-percent-form`)
    await f.page.locator('.device-key-settings').scrollIntoViewIfNeeded()
    await f.page.screenshot({path:join(output,`${width}-large-text.png`)})
    checks.push(`${width}-150-percent-text`);await f.context.close()
  }
  for(const state of ['disabled','config-error','list-error','malformed','list-malformed','unsupported','alternate']) {
    const f=await fixture({origin:state==='alternate'?alternate:main,supported:state!=='unsupported',state})
    const card=f.page.locator('.device-key-settings')
    assert.equal(await card.getByRole('heading',{name:'快捷登录',exact:true}).count(),1)
    assert.equal(await card.getByRole('button',{name:'添加通行密钥',exact:true}).count(),state==='alternate'?1:0)
    if(state==='alternate') {
      assert.ok((await card.innerText()).includes('不会互通'))
      assert.ok((await card.innerText()).includes('nav.cristsau.cn'))
      assert.equal(f.page.url(),alternate+'/settings?category=security','must not auto navigate')
      assert.equal(f.mock.keyReads,1,'enabled alternate origin enumerates its own keys')
      await card.scrollIntoViewIfNeeded();await f.page.screenshot({path:join(output,'alternate-guidance.png')})
      await card.getByRole('button',{name:'添加通行密钥',exact:true}).click()
      await f.page.getByLabel('验证当前账号密码',{exact:true}).fill('synthetic-cancel-only')
      await card.getByRole('button',{name:'取消',exact:true}).click()
      checks.push('alternate-enabled-local-enrollment-entry');await f.context.close();continue
    } else if(state==='disabled')assert.ok((await card.innerText()).includes('暂未启用'))
    else if(state==='unsupported')assert.ok((await card.innerText()).includes('未检测到可用'))
    else assert.equal(await card.getByRole('alert').count(),1)
    await verifyGeometry(f.page,state)
    const reads=f.mock.configReads;f.mock.state='enabled'
    await card.getByRole('button',{name:'重新检查',exact:true}).click()
    await f.page.waitForFunction(()=>document.querySelector('.device-key-settings')?.getAttribute('aria-busy')==='false')
    assert.equal(f.mock.configReads,reads+1)
    if(!['unsupported','alternate'].includes(state))await card.getByRole('button',{name:'添加通行密钥',exact:true}).waitFor()
    assert.equal(f.mock.mutations,0)
    checks.push(state+'-visible-and-retry');await f.context.close()
  }
  for(const theme of ['light','dark']) {
    const f=await fixture({theme,keyName:'我的 iPhone'})
    await verifyGeometry(f.page,`390-${theme}-standard-name`)
    await f.page.locator('.device-key-settings').evaluate(el=>window.scrollTo({top:window.scrollY+el.getBoundingClientRect().top-138}))
    await f.page.screenshot({path:join(output,`preview-390-${theme}.png`)})
    checks.push(`390-${theme}-standard-name-preview`);await f.context.close()
  }
  assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpected,[])
  await writeFile(join(output,'report.json'),JSON.stringify({status:'PASS',scope:'local Chromium built Vue, synthetic admin/API; not real iPhone, Safari, production or provider acceptance',checks,pageErrors,unexpected},null,2))
  console.log(JSON.stringify({status:'PASS',checks:checks.length,output}))
} catch(error) {
  await writeFile(join(output,'failure.json'),JSON.stringify({checks,pageErrors,unexpected,error:error.message},null,2))
  console.error(JSON.stringify({status:'FAIL',checks:checks.length,output,pageErrors,unexpected}));throw error
} finally {await browser.close()}
