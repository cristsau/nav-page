import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import monitorRoutes from '../src/routes/monitor.js'
import {normalizeMonitorPatch,probeSummary,overview,nodeState,readNodes,monitorForUser,proposeMonitorChange,confirmMonitorChange,validateProbeReport,probeTokenHash} from '../src/lib/monitorWorkspace.js'
import {normalizeExtraction,validateMonitorImage,monitorAiFacts} from '../src/lib/monitorAi.js'
import {classifyAssistantIntent,isMonitorChangeRequest} from '../src/lib/assistantIntent.js'
const owner='11111111-1111-4111-8111-111111111111'
const settings={version:1,enabled:true,ownerUserId:owner,password:'synthetic-only-password',upstream:'http://nav-monitor:28080',site:'https://node.cvv.gr'}
const now=Date.parse('2026-10-28T14:00:00Z')
const node={id:1,name:'Synthetic OVH',online:true,last_seen_ago:5,metrics:{cpu:22,mem_used:500,mem_total:1000,disk_used:400,disk_total:1000,net_rx:512,net_tx:256},mem_total:1000,disk_total:1000,price:120,currency:'USD',billing_cycle:'yearly',expires_at:'2026-11-01',expires_in:4,group:'测试',notify:false,month_used:900,traffic_limit:1000,traffic_mode:'up',remark:'secret=do-not-forward',token:'do-not-forward'}
const sample={node_id:1,carrier:'cu',observed_at:new Date(now).toISOString(),received_at:new Date(now).toISOString(),sent:5,received:4,avg_ms:120,min_ms:110,max_ms:140,address:'192.0.2.1',error:null}
const bridgeFor=n=>({request:async()=>Response.json({nodes:[n],admin:true})})

test('metadata allowlist rejects security fields, malformed dates and unsafe links',()=>{
  for(const patch of [{token:'x'},{public:true},{expires_at:'02/12/2026'},{expires_at:'2026-02-30'},{expires_at:'2026-99-99'},{currency:'usd'},{price:NaN},{links:[{title:'x',url:'https://u:pass@example.test'}]},{links:[{title:'x',url:'javascript:alert(1)'}]},{links:[{title:'x',url:'https://example.test/?token=secret'}]}])assert.throws(()=>normalizeMonitorPatch(patch))
  assert.deepEqual(normalizeMonitorPatch({expires_at:null,billingDate:'2026-12-02',tags:['a','a'],billing_cycle:'yearly'}),{expires_at:null,billingDate:'2026-12-02',tags:['a'],billing_cycle:'yearly'})
  assert.equal(normalizeMonitorPatch({billing_cycle:'12m'}).billing_cycle,'yearly')
})
test('ICMP loss is weighted by packets; interruptions and permission errors are not packet loss',()=>{
  const rows=[sample,{...sample,observed_at:new Date(now-60000).toISOString(),received:5,avg_ms:100},{...sample,observed_at:new Date(now-120000).toISOString(),sent:0,received:0,avg_ms:null,error:'permission'}]
  const result=probeSummary(rows,now)[0]
  assert.equal(result.sent,10);assert.equal(result.received,9);assert.equal(result.lossPercent,10);assert.equal(result.missingSamples,1)
  assert.equal(result.averageMs,(120*4+100*5)/9)
  assert.equal(probeSummary([{...sample,received_at:new Date(now-240000)}],now)[0].status,'stale')
  assert.equal(probeSummary([],now)[0].lossPercent,null)
  assert.equal(probeSummary([{...sample,sent:0,received:0,avg_ms:null,error:'dns'}],now)[0].lossPercent,null)
  assert.equal(probeSummary([{...sample,received:0,avg_ms:null}],now)[0].lossPercent,100)
})
test('overview excludes private upstream fields, preserves unknown values, separates currencies and stale nodes',()=>{
  const result=overview([node,{...node,id:2,currency:'CNY',price:60,billing_cycle:'semiannual',online:false,metrics:null}],[],[sample],now)
  assert.equal(result.nodes[0].memory,50);assert.equal(result.nodes[1].cpu,null)
  assert.equal(result.costs.USD,10);assert.equal(result.costs.CNY,10)
  assert.equal(JSON.stringify(result).includes('do-not-forward'),false)
  assert.equal(result.alerts.filter(a=>a.kind==='offline').length,1)
  assert.equal(overview([node],[],[],now,[{node_id:1}]).nodes[0].carriers[0].status,'stale')
})
test('probe payload requires exactly three carriers, real counters, bounded latency and recent timestamps',()=>{
  const body={nodeId:1,observedAt:new Date(now).toISOString(),samples:['cu','cm','ct'].map(carrier=>({carrier,address:'192.0.2.1',sent:5,received:4,avgMs:120,minMs:110,maxMs:140,error:null}))}
  assert.equal(validateProbeReport(body,now),body)
  for(const change of [{nodeId:0},{observedAt:'invalid'},{observedAt:new Date(now-360000).toISOString()},{samples:[body.samples[0],body.samples[0],body.samples[2]]},{samples:[null,null,null]},{services:[{unit:'../../x',status:'active'}]}]) assert.throws(()=>validateProbeReport({...body,...change},now))
  for(const change of [{address:'999.1.1.1'},{received:6},{avgMs:-1},{error:'permission'},{sent:0,received:0,avgMs:0},{minMs:200}])assert.throws(()=>validateProbeReport({...body,samples:body.samples.map((s,i)=>i===0?{...s,...change}:s)},now))
  assert.equal(probeTokenHash('synthetic').length,64)
})
test('screenshot slash dates stay unresolved and billing is never silently promoted to expiry',()=>{
  const r=normalizeExtraction({rawExpiry:'02/12/2026',rawBillingDate:'2026-12-02',identifiedServer:'unknown',price:12,currency:'USD'})
  assert.equal(r.patch.expires_at,undefined);assert.equal(r.patch.billingDate,'2026-12-02');assert.equal(r.warnings.length,1)
  assert.equal(normalizeExtraction({rawBillingDate:'02/12/2026'}).patch.expires_at,undefined)
  assert.throws(()=>validateMonitorImage('https://example.test/image.png'))
  assert.throws(()=>validateMonitorImage('data:image/png;base64,YWJjZA=='))
  const facts=monitorAiFacts(overview([node],[],[],now).nodes[0]);assert.equal(facts.ipv4,undefined);assert.equal(facts.token,undefined)
})
test('reads fail closed for non-owner and anonymous upstream snapshots',async()=>{
  await assert.rejects(()=>monitorForUser('other',{load:async()=>settings}),e=>e.statusCode===403)
  await assert.rejects(()=>readNodes({request:async()=>Response.json({nodes:[],admin:false})}),e=>e.code==='MONITOR_UNAVAILABLE')
})
test('proposal captures a preview and never writes to the upstream',async()=>{
  const requests=[],db=[]
  const bridge={request:async(path,options)=>{requests.push({path,options});return Response.json({nodes:[node],admin:true})}}
  const draft=await proposeMonitorChange(owner,bridge,1,{expires_at:'2026-12-02'},async(sql,params)=>{db.push({sql,params});return {rows:[]}})
  assert.equal(draft.status,'preview');assert.equal(draft.before.expires_at,node.expires_at);assert.equal(requests.length,1);assert.equal(requests[0].options.method,undefined)
  assert.match(draft.href,/^\/monitor\?node=1&change=/);assert.ok(db[1].sql.includes('INSERT INTO monitor_changes'))
})
test('a form opened before a concurrent update cannot propose overwriting that update',async()=>{
  let inserts=0
  await assert.rejects(()=>proposeMonitorChange(owner,bridgeFor(node),1,{expires_at:'2026-12-02'},async sql=>{if(sql.startsWith('INSERT'))inserts++;return {rows:[]}}, {expires_at:'2025-01-01'}),e=>e.code==='MONITOR_CHANGE_CONFLICT')
  assert.equal(inserts,0)
})
function transactionFixture({status='preview',drift=false,failWrite=false}={}){
  const row={id:'22222222-2222-4222-8222-222222222222',node_id:1,status,before_state:nodeState(node),patch:{expires_at:'2026-12-02'},expires_at:new Date(Date.now()+60000)}
  const writes=[],sqls=[];let current={...node}
  const client={query:async(sql)=>{sqls.push(sql);if(sql.includes('SELECT * FROM monitor_changes'))return {rows:[row]};if(sql.includes('SELECT 1 FROM monitor_changes'))return {rowCount:0,rows:[]};if(sql.includes('SELECT details'))return {rows:[]};if(sql.includes("status='applying'"))row.status='applying';if(sql.includes("status='applied'"))row.status='applied';if(sql.includes("status='uncertain'"))row.status='uncertain';return {rows:[]}}}
  const bridge={request:async(path,options={})=>{if(options.method==='PUT'){writes.push(path);if(failWrite)throw Error('synthetic lost response');current={...current,...JSON.parse(options.body)};return Response.json({ok:true})}return Response.json({nodes:[drift?{...current,group:'changed elsewhere'}:current],admin:true})}}
  return {row,writes,sqls,bridge,transaction:fn=>fn(client)}
}
test('confirmation writes once, verifies readback and replay is idempotent',async()=>{
  const f=transactionFixture()
  f.row.before_state=Object.fromEntries(Object.entries(f.row.before_state).reverse())
  const result=await confirmMonitorChange(owner,f.bridge,f.row.id,f.transaction)
  assert.equal(result.status,'applied');assert.equal(f.writes.length,1)
  await confirmMonitorChange(owner,f.bridge,f.row.id,f.transaction);assert.equal(f.writes.length,1)
})
test('stale preview never overwrites a concurrent change',async()=>{
  const f=transactionFixture({drift:true});await assert.rejects(()=>confirmMonitorChange(owner,f.bridge,f.row.id,f.transaction),e=>e.code==='MONITOR_CHANGE_CONFLICT');assert.equal(f.writes.length,0)
})
test('lost write response stays uncertain; a repeat confirm does not write again',async()=>{
  const f=transactionFixture({failWrite:true});await assert.rejects(()=>confirmMonitorChange(owner,f.bridge,f.row.id,f.transaction),e=>e.code==='MONITOR_CHANGE_REVIEW');assert.equal(f.row.status,'uncertain')
  await assert.rejects(()=>confirmMonitorChange(owner,f.bridge,f.row.id,f.transaction));assert.equal(f.writes.length,1)
})
test('new monitor endpoints require owner admin before touching DB or model',async()=>{
  const app=Fastify();let user=null,hits=0
  app.decorate('requireAdmin',async(req,reply)=>{if(!user){reply.code(401);throw Error('auth')}if(user.role!=='admin'){reply.code(403);throw Error('admin')}req.currentUser=user})
  await app.register(monitorRoutes,{prefix:'/api',loadConfig:async()=>settings,fetcher:async()=>{hits++;throw Error('must not call')}})
  for(const current of [null,{id:owner,role:'user'},{id:'22222222-2222-4222-8222-222222222222',role:'admin'}]){
    user=current
    for(const url of ['/api/monitor/overview','/api/monitor/nodes/1/history','/api/monitor/nodes/1/changes','/api/monitor/nodes/1/carriers?range=30d','/api/monitor/admin/settings','/api/monitor/admin/nodes'])assert.equal((await app.inject(url)).statusCode,current?403:401)
    for(const url of ['/api/monitor/nodes/1/proposals','/api/monitor/nodes/1/ai','/api/monitor/changes/22222222-2222-4222-8222-222222222222/confirm'])assert.equal((await app.inject({method:'POST',url,payload:{}})).statusCode,current?403:401)
  }
  assert.equal(hits,0);assert.equal((await app.inject({method:'POST',url:'/api/monitor/probes/report',payload:{}})).statusCode,401);await app.close()
})
test('monitor edit requests enter preview tool path, ordinary advice does not become a write',()=>{
  assert.equal(classifyAssistantIntent('帮我把 OVH 到期时间修改为 2026-12-02').action,true)
  assert.equal(classifyAssistantIntent('我的服务器内存够用吗').action,false)
  assert.equal(isMonitorChangeRequest('更新服务器续费备忘录'),false)
  assert.equal(isMonitorChangeRequest('设置 OVH 到期提醒'),false)
})
