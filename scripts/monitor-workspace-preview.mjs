// Local synthetic preview. Does not contact NAV, monitor, Cloudflare or an AI provider.
import {createRequire} from 'node:module'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import {overview} from '../api/src/lib/monitorWorkspace.js'
const evidence=process.env.NAV_MONITOR_PREVIEW_OUTPUT
if(!evidence||!resolve(evidence).startsWith('D:\\DomoCodex\\'))throw Error('Explicit D:\\DomoCodex evidence directory required')
await mkdir(evidence,{recursive:true})
const root=resolve('app'),req=createRequire(join(root,'package.json'))
const {createServer}=await import(pathToFileURL(req.resolve('vite')).href)
const html=`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test"></div><script type="module">import{createApp,h}from'vue';import{createRouter,createMemoryHistory}from'vue-router';import View from'/src/modules/monitor/MonitorView.vue';import Shell from'/src/shared/components/AppShell.vue';import{useAuth}from'/src/shared/composables/useAuth.js';import{\u0024isDark}from'/src/shared/composables/useTheme.js';import'/src/styles/reset.css';import'/src/styles/variables.css';const auth=useAuth();auth.currentUser.value={id:'synthetic-owner',username:'合成管理员',role:'admin'};\u0024isDark.value=new URLSearchParams(location.search).get('dark')==='1';const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:View}]});await router.push('/monitor');const app=createApp({render:()=>h(Shell,null,{default:()=>h(View)})});app.use(router);app.mount('#test');</script><style>body{background:var(--bg-primary);color:var(--text-primary);font-family:system-ui,sans-serif;margin:0}</style></body></html>`
const names=['OVH','USPH','SJC','Ali-HK','v.ps-JP','ISJP','66-JP','66-US-4837','Bagevm-HK','Onidel-SG']
const now=Date.now(),nodes=names.map((name,i)=>({id:i+1,name:`合成 ${name}`,online:i!==5,last_seen_ago:i===5?600:5,metrics:i===5?null:{cpu:10+i*3,mem_used:(i===1?920:200+i*30)*1024**2,mem_total:1024**3,disk_used:(8+i)*1024**3,disk_total:40*1024**3,net_rx:1024*(50+i*5),net_tx:1024*(10+i*2),load:[.2,.1,.1],uptime:86400},mem_total:1024**3,disk_total:40*1024**3,price:12+i,currency:i%3?'USD':'CNY',billing_cycle:'monthly',expires_at:'2026-11-28',expires_in:i===2?3:31,group:i%2?'海外':'亚太',notify:true,month_used:(100+i*10)*1024**3,traffic_limit:1000*1024**3,traffic_mode:'sum',os:'Debian 12',cpu_cores:2,agent_version:'1.2.3',ipv4:`192.0.2.${i+1}`,cpu_name:'Synthetic CPU'}))
const details=nodes.map(n=>({node_id:n.id,details:{provider:'合成供应商',purpose:n.id===1?'NAV · 监控中心':n.id===2?'离线下载 · 视频转码':'代理与测试',tags:['个人'],links:[]}}))
const samples=nodes.filter(n=>n.id!==10).flatMap(n=>['cu','cm','ct'].flatMap((carrier,j)=>Array.from({length:30},(_,i)=>({node_id:n.id,carrier,address:`192.0.2.${100+j}`,observed_at:new Date(now-(29-i)*60000).toISOString(),received_at:new Date(now-(29-i)*60000).toISOString(),sent:5,received:n.id===4&&i%5===0?4:5,avg_ms:80+n.id*5+j*22+Math.sin(i)*8,min_ms:70,max_ms:200,error:null}))))
const changes=[];let fail=false
const respond=(res,value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))}
const server=await createServer({root,cacheDir:join(evidence,'vite-cache'),server:{host:'127.0.0.1',port:4196,strictPort:true},plugins:[{name:'monitor-workspace-lab',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,'http://127.0.0.1')
  if(url.pathname==='/__monitor-lab'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await vite.transformIndexHtml(url.pathname,html));return}
  if(url.pathname==='/__monitor-stage'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><body style="margin:0;background:#222;color:white;font:14px system-ui"><label>预览尺寸 <select onchange="document.querySelector('iframe').style.width=this.value+'px'"><option value="1440">桌面 1440</option><option value="1024">平板 1024</option><option value="390">手机 390</option><option value="320">窄屏 320</option></select></label><button onclick="document.querySelector('iframe').src='/__monitor-lab?dark=1'">深色</button><button onclick="document.querySelector('iframe').src='/__monitor-lab'">浅色</button><iframe title="NAV 合成预览" src="/__monitor-lab" style="display:block;width:1440px;max-width:100%;height:100vh;border:0"></iframe></body></html>`);return}
  if(!url.pathname.startsWith('/api/'))return next()
  if(url.pathname==='/api/monitor/overview')return respond(res,fail?{error:'合成连接暂不可用'}:overview(nodes,details,samples,Date.now(),nodes.map(n=>({node_id:n.id,last_report_at:new Date(now).toISOString(),services:[{unit:'nav-monitor-agent.service',status:'active'}]}))),fail?503:200)
  if(url.pathname.endsWith('/history'))return respond(res,{step:60,metrics:Array.from({length:30},(_,i)=>({ts:Math.floor(now/1000)-(29-i)*60,cpu:10+Math.sin(i)*5,net_rx:10000+i*20,net_tx:5000+i*10}))})
  if(url.pathname.endsWith('/changes'))return respond(res,{changes})
  if(url.pathname.endsWith('/proposals')){let body='';for await(const part of req)body+=part;const patch=JSON.parse(body).patch,nodeId=Number(url.pathname.split('/')[4]),before=overview(nodes,details,[],now).nodes.find(n=>n.id===nodeId);const draft={id:'22222222-2222-4222-8222-222222222222',node_id:nodeId,name:before.name,before_state:before,before,patch,status:'preview',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString()};changes.push(draft);return respond(res,draft)}
  if(url.pathname.endsWith('/confirm')){const row=changes.at(-1);if(row){Object.assign(nodes.find(n=>n.id===row.node_id),row.patch);Object.assign(details.find(n=>n.node_id===row.node_id).details,row.patch);row.status='applied'}return respond(res,{status:'applied'})}
  if(url.pathname.endsWith('/ai'))return respond(res,{patch:{price:24,currency:'USD'},rawExpiry:'02/12/2026',rawBillingDate:'',warnings:['到期日期原文 02/12/2026：请核对日/月顺序后手动填写。'],identifiedServer:'合成 OVH',evidence:'合成账单，每周期 USD 24；日期格式未确认。',model:'synthetic-no-provider'})
  if(url.pathname.startsWith('/api/notifications'))return respond(res,{notifications:[],unreadCount:0})
  respond(res,{error:'Synthetic endpoint not implemented'},404)
})}}]})
await server.listen()
await writeFile(join(evidence,'preview.json'),JSON.stringify({url:'http://127.0.0.1:4196/__monitor-stage',data:'synthetic',productionWrites:0},null,2))
console.log('Synthetic monitor preview: http://127.0.0.1:4196/__monitor-stage')
