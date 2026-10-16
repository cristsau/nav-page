// Built frontend, synthetic data, loopback only. Not real-user or production acceptance.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'
import { hostname } from 'node:os'
assert.equal(hostname().toUpperCase(), 'WIN-KBP9PCRLBCT')
const { chromium } = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE)
const dist = resolve('app/dist'), out = process.env.NAV_WORKBENCH_EVIDENCE
assert.ok(out, 'Explicit evidence path required')
await mkdir(out, { recursive: true })
const types = { '.js':'application/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' }
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/__fixture.svg') {
      res.setHeader('Content-Type', 'image/svg+xml')
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="340"><rect width="480" height="340" fill="#6c64b4"/><circle cx="330" cy="110" r="65" fill="#c7c2ec"/><path d="M0 340L150 120L360 340" fill="#373258"/></svg>')
    }
    const file = resolve(dist, '.' + (path === '/' || !extname(path) ? '/index.html' : decodeURIComponent(path)))
    assert.ok(file.startsWith(dist + sep))
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath:process.env.NAV_BROWSER_PATH, headless:true })
const checks = [], errors = [], unexpected = [], measurements = []
const user = {id:'synthetic-workbench',username:'Design reviewer',role:'admin',status:'approved'}
const now = '2026-10-16T08:00:00Z'
const notes = Array.from({length:5},(_,i)=>({id:`note-${i}`,numberId:1042+i,type:i===4?'diary':'memo',title:['服务器续费与迁移清单','周末旅行计划','整理这一周的灵感','下一版界面验收','沿海散步的一天'][i],content:'这是隔离环境中的合成笔记。测试阅读、编辑与键盘操作，不访问真实账号数据。',contentFormat:'plain',tags:['合成测试'],revision:1,pinned:i===0,encrypted:false,completed:false,attachments:[],createdAt:now,updatedAt:now,entryDate:'2026-10-16',accessRole:'owner'}))
const groups = [{id:'work',name:'工作',icon:'briefcase',order:0},{id:'life',name:'生活',icon:'heart',order:1}]
const bookmarks = Array.from({length:12},(_,i)=>({id:`bookmark-${i}`,groupId:i<8?'work':'life',title:['项目看板','设计稿库','团队文档','代码仓库','日历','服务器状态','监控面板','工单系统','图片库','构建流水线','知识库','云盘'][i],url:`https://example.test/${i}`,description:'合成验收链接',tags:[],order:i,healthStatus:'ok',pinned:i<4}))
const files = [{id:'id:folder',name:'旅行手记',type:'folder',kind:'folder',path:'/旅行手记',mutable:true},{id:'id:protected',name:'Apps',type:'folder',kind:'folder',path:'/Apps',mutable:false},...['旅行照片.png','周末旅行计划.md','海边随拍.mp4'].map((name,i)=>({id:`id:file-${i}`,name,type:'file',kind:['image','text','video'][i],path:'/'+name,mutable:true,rev:'synthetic',size:1024,modified:now,downloadable:true}))]
const fixture = async (context, theme, authenticated=true) => {
  await context.addInitScript(theme=>localStorage.setItem('nav-theme',theme),theme)
  await context.routeWebSocket('**/*',s=>s.close())
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname.slice(4)
    if(url.origin!==origin){unexpected.push('EXTERNAL '+url.origin);return route.abort()}
    if(!url.pathname.startsWith('/api/'))return route.continue()
    let body
    if(req.method()==='PUT' && p.startsWith('/settings/')) body={ok:true}
    else if(!['GET','HEAD'].includes(req.method()) && !['/dropbox-files/list','/dropbox-files/upload/list'].includes(p)) {
      unexpected.push(req.method()+' '+p);return route.fulfill({status:403,json:{error:'Synthetic read-only fixture'}})
    } else if(p==='/auth/session')body={user:authenticated?user:null}
    else if(p==='/auth/capabilities')body={password:true,emailLogin:true,emailBinding:true,emailPasswordReset:true,passkey:false}
    else if(p==='/auth/oauth/config')body={providers:{google:{enabled:true},wechat:{enabled:false}}}
    else if(p==='/auth/device-keys/config')body={enabled:false,configured:false,optional:true}
    else if(p==='/auth/registration/config')body={emailVerificationEnabled:false,emailRequired:false}
    else if(p==='/auth/bot-guard/config')body={enabled:false,siteKey:''}
    else if(p==='/settings/theme')body={value:theme}
    else if(p.startsWith('/settings/'))body={value:null}
    else if(p.startsWith('/notifications'))body={notifications:[],unreadCount:0}
    else if(p==='/groups')body={groups}
    else if(p==='/bookmarks')body={bookmarks}
    else if(p==='/search-engines' || p==='/search-engines/custom')body={engines:[]}
    else if(p==='/notes')body={notes}
    else if(p==='/note-reminders')body={reminders:[],unreadCount:0}
    else if(p==='/collaboration/sync/bootstrap')body={notes,members:[],comments:[],cursor:1}
    else if(p==='/collaboration/sync/changes')body={events:[],cursor:1,hasMore:false}
    else if(/^\/collaboration\/notes\/note-\d+$/.test(p))body={members:[],comments:[]}
    else if(p==='/media/images')body={images:Array.from({length:8},(_,i)=>({id:`image-${i}`,name:`合成图片 ${i+1}`,url:origin+'/__fixture.svg',thumbnailUrl:origin+'/__fixture.svg',width:480,height:340,size:1024,status:'available',referenceCount:i%3,retention:'keep',createdAt:now})),counts:{all:8},nextCursor:''}
    else if(p==='/assistant/conversations')body={conversations:[{id:'chat-1',title:'整理周末旅行清单',updatedAt:now}]}
    else if(p==='/assistant/conversations/chat-1')body={conversation:{id:'chat-1',title:'整理周末旅行清单'},messages:[{id:'msg-1',role:'user',content:'帮我整理周末旅行计划'},{id:'msg-2',role:'assistant',content:'下面是合成测试回复：先确认交通，再核对住宿。没有修改原笔记。',sources:[{title:'周末旅行计划',type:'note',id:'note-1'}]}]}
    else if(p==='/ai-search/providers/chatgpt/models')body={models:[{id:'synthetic-model',label:'合成模型'}],defaultModel:'synthetic-model',reasoningEfforts:[]}
    else if(p==='/dropbox-files/status')body={connected:true,textLimit:1048576,uploadLimit:50*1024**3,chunkSize:8*1024**2,uploadResume:'reselect_after_restart_encrypted',deletedFiles:true}
    else if(p==='/dropbox-files/list')body={entries:files,cursor:null,hasMore:false}
    else if(p==='/dropbox-files/upload/list')body={entries:[]}
    else {unexpected.push(req.method()+' '+p);return route.fulfill({status:404,json:{error:'Unmocked synthetic endpoint'}})}
    await route.fulfill({json:body})
  })
}
async function geometry(page,label){
  const result=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth}))
  assert.ok(result.scroll<=result.width+1,`${label}: overflow ${JSON.stringify(result)}`)
  await page.screenshot({path:join(out,label+'.png'),fullPage:!label.startsWith('editor-')})
  checks.push(label)
}
try {
 for (const failure of [false,true]) {
  const context=await browser.newContext({viewport:{width:390,height:900},isMobile:true,hasTouch:true,reducedMotion:'reduce',serviceWorkers:'block'})
  await fixture(context,'light')
  let releaseLoad
  const gate=new Promise(resolveLoad=>{releaseLoad=resolveLoad})
  await context.route('**/NoteEditor-*.js',async route=>{if(failure)return route.abort();await gate;await route.continue().catch(()=>{})})
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
  await page.goto(origin+'/whisper',{waitUntil:'networkidle'})
  await page.getByRole('button',{name:'新建记录',exact:true}).click();await page.getByRole('menuitem').filter({hasText:'备忘录'}).click()
  const dialog=page.getByRole('dialog')
  await dialog.getByText(failure?'编辑器暂时未能加载':'正在打开编辑器…',{exact:true}).waitFor()
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'detached'})
  releaseLoad()
  if(!failure){
   await page.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>/\/NoteEditor-[^/]+\.js$/.test(r.name)))
   assert.equal(await page.locator('.editor-modal').count(),0,'late load never reopens a dismissed editor')
   await page.getByRole('button',{name:'新建记录',exact:true}).click();await page.getByRole('menuitem').filter({hasText:'备忘录'}).click()
   await page.locator('.editor__title-input').waitFor()
  }
  checks.push(failure?'lazy-editor-network-failure-is-closable':'lazy-editor-slow-load-close-and-reopen')
  await context.close()
 }
 for(const theme of ['light','dark']) for(const width of [1440,900,390,320]){
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<821,hasTouch:width<821,colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'})
  await fixture(context,theme)
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message))
  for(const [path,ready,name] of [['/','.bookmarks-container','navigation'],['/whisper','.note-card','notes'],['/media','.media-card','media'],['/files','.drive-list li','files'],['/assistant','.assistant-workspace','assistant'],['/settings','.settings-content','settings']]){
   const started=Date.now();await page.goto(origin+path,{waitUntil:'networkidle'});await page.locator(ready).first().waitFor()
   if(path==='/assistant'){await page.getByText('整理周末旅行清单',{exact:true}).click();await page.locator('.assistant-message.is-assistant').waitFor()}
   await geometry(page,`${name}-${theme}-${width}`)
   assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark')
   measurements.push({path,theme,width,elapsedMs:Date.now()-started,resources:await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>/\.(js|css)$/.test(r.name)).map(r=>({name:new URL(r.name).pathname,bytes:r.encodedBodySize})))})
   if(path==='/settings'&&width>820)assert.equal(await page.locator('.primary-header__settings').getAttribute('aria-current'),'page')
   if(path==='/'&&width===1440){
    const trigger=page.getByRole('button',{name:'打开搜索与命令面板'});await trigger.click();await page.getByRole('combobox',{name:'搜索命令'}).waitFor();await page.keyboard.press('Escape');assert.ok(await trigger.evaluate(el=>el===document.activeElement))
    await page.keyboard.press('Control+k');await page.getByRole('combobox',{name:'搜索命令'}).waitFor();await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'收起侧栏'}).click();await page.waitForFunction(()=>Math.round(document.querySelector('.primary-header').getBoundingClientRect().width)===76);assert.equal(await page.locator('.primary-header').evaluate(e=>Math.round(e.getBoundingClientRect().width)),76)
    await page.getByRole('button',{name:'展开侧栏'}).click();checks.push('command-focus-collapse-'+theme)
   }
   if(path==='/whisper'){
    await page.getByText(notes[0].title,{exact:true}).click();await page.locator('.preview-card').waitFor()
    assert.equal(await page.locator('.preview-card').getAttribute('role'),width>1100?'region':'dialog')
    await geometry(page,`reader-${theme}-${width}`)
    await page.getByRole('button',{name:'关闭预览',exact:true}).click()
    const loaded=await page.evaluate(()=>performance.getEntriesByType('resource').map(r=>r.name));assert.ok(!loaded.some(n=>/\/NoteEditor-[^/]+\.js$/.test(n)),'Editor must not load before use')
    await page.getByRole('button',{name:'新建记录',exact:true}).click();await page.getByRole('menuitem').filter({hasText:'备忘录'}).click()
    await page.locator('.editor__title-input').waitFor();assert.equal(await page.locator('.editor__properties').getAttribute('open'),null)
    await geometry(page,`editor-${theme}-${width}`)
    await page.getByRole('button',{name:'属性',exact:true}).click();assert.equal(await page.locator('.editor__properties').evaluate(e=>e.open),true)
    await page.getByRole('button',{name:'关闭编辑器',exact:true}).click();await page.locator('.editor-modal').waitFor({state:'detached'});checks.push('editor-lazy-fullscreen-close-'+theme+'-'+width)
    const summary=page.locator('.note-card__menu > summary').first()
    if(width<821){const box=await summary.boundingBox();assert.ok(box.width>=43.5&&box.height>=43.5,JSON.stringify({box,state:await summary.evaluate(el=>({width:getComputedStyle(el).width,height:getComputedStyle(el).height,coarse:matchMedia('(pointer:coarse)').matches}))}))}
    await summary.click()
    await page.getByRole('button',{name:'编辑 '+notes[0].title,exact:true}).click();await page.locator('.editor__title-input').waitFor()
    assert.equal(await page.locator('.editor__title-input').inputValue(),notes[0].title)
    await page.getByRole('button',{name:'关闭编辑器',exact:true}).click();await page.locator('.editor-modal').waitFor({state:'detached'})
    assert.ok(await summary.evaluate(el=>el===document.activeElement),'menu edit restores focus')
    await summary.press('Enter');await page.getByRole('button',{name:'编辑 '+notes[0].title,exact:true}).waitFor();await summary.press('Escape')
    assert.equal(await page.locator('.note-card__menu').first().evaluate(el=>el.open),false)
    checks.push('note-actions-edit-return-focus-'+theme+'-'+width)
   }
   if(path==='/files'&&width<821){assert.equal(await page.locator('.drive-tools').evaluate(e=>e.open),false);await page.locator('.drive-tools > summary').click();assert.equal(await page.getByRole('button',{name:'离线下载',exact:true}).isVisible(),true)}
  }
  await context.close()
 }
 for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',serviceWorkers:'block'});await fixture(context,'light',false)
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/auth',{waitUntil:'networkidle'});await geometry(page,'login-'+width);await context.close()
 }
 assert.deepEqual(errors,[]);assert.deepEqual([...new Set(unexpected)],[])
 await writeFile(join(out,'report.json'),JSON.stringify({status:'PASS',checks,errors,unexpected,measurements,production:false,realCloudData:false},null,2))
 console.log(JSON.stringify({status:'PASS',checks:checks.length,errors:errors.length,unexpected:unexpected.length}))
 } catch(error){
 const pages=browser.contexts().flatMap(c=>c.pages())
 for(const [i,page] of pages.entries()) {
  await page.screenshot({path:join(out,'failure-'+i+'.png'),fullPage:true}).catch(()=>{})
  measurements.push({failureState:await page.evaluate(()=>({url:location.pathname,classes:document.querySelector('.app-shell')?.className,sidebar:document.querySelector('.primary-header')?.getBoundingClientRect().toJSON(),savedSidebar:localStorage.getItem('nav-sidebar-collapsed'),text:document.body.innerText.slice(0,1800)})).catch(()=>({}))})
 }
 await writeFile(join(out,'failure.json'),JSON.stringify({status:'FAIL',error:String(error),checks,errors,unexpected,measurements},null,2));throw error
} finally {await browser.close();await new Promise(r=>server.close(r))}
