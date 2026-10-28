import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { maintainMonitorHistory,readCarrierHistory,invalidateMonitorCache } from '../src/lib/monitorHistory.js'

// Never run this destructive fixture against an ordinary or remote database.
assert.equal(process.env.NODE_ENV,'test')
assert.equal(process.env.NAV_MONITOR_INTEGRATION_TEST,'true')
const target=new URL(process.env.DATABASE_URL)
assert.ok(['postgres:','postgresql:'].includes(target.protocol))
assert.ok(['127.0.0.1','localhost'].includes(target.hostname))
assert.equal(target.pathname,'/nav_monitor_workspace_test')
assert.equal(target.search,'')
const owner='11111111-1111-4111-8111-111111111111'
const settings={version:1,enabled:true,ownerUserId:owner,password:'synthetic-integration-only',upstream:'http://nav-monitor:28080',site:'https://node.cvv.gr'}
const initial={id:1,name:'Synthetic VPS',online:true,last_seen_ago:5,price:12,currency:'USD',billing_cycle:'monthly',expires_at:'2026-12-02',group:'',notify:false}
let pool,app,privateDir,config,originalDir,node,writes,lostResponse,user
before(async()=>{
  const database=await import('../src/db/index.js');pool=database.pool
  config=(await import('../src/config.js')).config
  originalDir=config.managedIntegrationsDir
  privateDir=await mkdtemp(join(tmpdir(),'nav-monitor-integration-'))
  await writeFile(join(privateDir,'monitor.json'),JSON.stringify(settings),{mode:0o600})
  config.managedIntegrationsDir=privateDir
  app=Fastify()
  app.decorate('requireAdmin',async(req,reply)=>{req.currentUser=user;if(user.role!=='admin'){reply.code(403);throw Error('admin')}})
  const routes=(await import('../src/routes/monitor.js')).default
  await app.register(routes,{prefix:'/api',loadConfig:async()=>settings,fetcher:async(url,options)=>{
    if(url.endsWith('/auth/login'))return Response.json({ok:true},{headers:{'set-cookie':`monitor_session=${'b'.repeat(64)}; HttpOnly`}})
    if(options.method==='PUT'){writes++;Object.assign(node,JSON.parse(options.body));if(lostResponse)throw Error('synthetic response lost');return Response.json({ok:true})}
    return Response.json({nodes:[node],admin:true})
  }})
  await app.ready()
})
beforeEach(async()=>{
  invalidateMonitorCache(owner)
  await pool.query('TRUNCATE TABLE monitor_probe_maintenance')
  await pool.query('TRUNCATE TABLE users CASCADE')
  await pool.query("INSERT INTO users(id,username,password_hash,role,status,approved_at) VALUES($1,'monitor-fixture','not-a-password','admin','approved',NOW())",[owner])
  node={...initial};writes=0;lostResponse=false;user={id:owner,role:'admin'}
})
after(async()=>{await app?.close();if(config)config.managedIntegrationsDir=originalDir;await pool?.end();if(privateDir)await rm(privateDir,{recursive:true})})
async function request(path,payload={}){const r=await app.inject({method:'POST',url:'/api/monitor'+path,payload});return {status:r.statusCode,body:r.json()}}
async function preview(patch){const r=await request('/nodes/1/proposals',{patch});assert.equal(r.status,200);return r.body.id}
test('real JSONB round trip, confirm replay, undo conflict and ownership',async()=>{
  const id=await preview({expires_at:'2027-12-02',provider:'Example vendor'})
  assert.equal(writes,0)
  assert.equal((await request(`/changes/${id}/confirm`,{confirmed:true})).status,200)
  assert.equal((await request(`/changes/${id}/confirm`,{confirmed:true})).status,200)
  assert.equal(writes,1)
  const details=(await pool.query('SELECT details FROM monitor_node_details')).rows[0].details
  assert.equal(details.provider,'Example vendor')
  user={id:'22222222-2222-4222-8222-222222222222',role:'admin'}
  assert.equal((await request(`/changes/${id}/undo-preview`)).status,403)
  user={id:owner,role:'admin'};node.expires_at='2028-01-01'
  assert.equal((await request(`/changes/${id}/undo-preview`)).status,409)
  node.expires_at='2027-12-02'
  const undo=await request(`/changes/${id}/undo-preview`);assert.equal(undo.status,200)
  assert.equal((await request(`/changes/${undo.body.id}/confirm`,{confirmed:true})).status,200)
  assert.equal(node.expires_at,initial.expires_at)
})
test('concurrent proposals serialize writes and uncertain results reconcile without replay',async()=>{
  const first=await preview({price:24}),second=await preview({price:48})
  const results=await Promise.all([request(`/changes/${first}/confirm`,{confirmed:true}),request(`/changes/${second}/confirm`,{confirmed:true})])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(writes,1)
  const id=await preview({expires_at:'2027-01-01'});lostResponse=true
  assert.equal((await request(`/changes/${id}/confirm`,{confirmed:true})).status,409)
  assert.equal((await pool.query('SELECT status FROM monitor_changes WHERE id=$1',[id])).rows[0].status,'uncertain')
  assert.equal((await request(`/changes/${id}/confirm`,{confirmed:true})).status,409)
  lostResponse=false
  assert.equal((await request(`/changes/${id}/reconcile`)).body.status,'applied');assert.equal(writes,2)
})
test('probe credential binds one node, enforces cadence and supports revocation',async()=>{
  const {probeTokenHash}=await import('../src/lib/monitorWorkspace.js')
  const token='a'.repeat(64)
  await pool.query('INSERT INTO monitor_probe_credentials(node_id,user_id,token_hash) VALUES(1,$1,$2)',[owner,probeTokenHash(token)])
  const body={nodeId:1,observedAt:new Date().toISOString(),samples:['cu','cm','ct'].map(carrier=>({carrier,address:'192.0.2.1',sent:5,received:4,avgMs:100,minMs:90,maxMs:110,error:null})),services:[{unit:'nav-monitor-agent.service',status:'active'}]}
  const send=payload=>app.inject({method:'POST',url:'/api/monitor/probes/report',headers:{authorization:`Bearer ${token}`},payload})
  assert.equal((await send({...body,nodeId:2})).statusCode,401)
  assert.equal((await send(body)).statusCode,200)
  assert.equal((await pool.query('SELECT * FROM monitor_probe_samples')).rowCount,3)
  assert.equal((await send(body)).statusCode,429)
  await pool.query('UPDATE monitor_probe_credentials SET enabled=false')
  assert.equal((await send(body)).statusCode,401)
})


test('real rollups survive 3/7/30-day retention, are idempotent, and preserve weighted loss',async()=>{
  const start=new Date('2026-10-01T00:00:00Z')
  await pool.query("INSERT INTO monitor_probe_credentials(node_id,user_id,token_hash) VALUES(1,$1,$2)",[owner,'a'.repeat(64)])
  for(const [minute,received,ms,error] of [[1,4,100,null],[2,5,200,null],[3,0,null,'dns']]){
    await pool.query(`INSERT INTO monitor_probe_samples(node_id,carrier,observed_at,address,sent,received,avg_ms,min_ms,max_ms,error)
    VALUES(1,'cu',$1,'192.0.2.1',$2,$3,$4,$4,$4,$5)`,[new Date(+start+minute*60000),error?0:5,received,ms,error])
  }
  const now=new Date(+start+70*60000)
  await maintainMonitorHistory({now});await maintainMonitorHistory({now})
  const rolls=(await pool.query('SELECT * FROM monitor_probe_rollups ORDER BY step')).rows
  assert.equal(rolls.length,2);assert.equal(Number(rolls[0].sent),10);assert.equal(Number(rolls[0].received),9);assert.equal(rolls[0].rounds,3)
  let result=await readCarrierHistory(owner,1,'3d',{now})
  assert.equal(result.carriers[0].lossPercent,10);assert.equal(result.carriers[0].averageMs,1400/9);assert.equal(result.carriers[0].errorRounds,1)
  await maintainMonitorHistory({now:new Date(+start+4*86400000)})
  assert.equal((await pool.query('SELECT COUNT(*) FROM monitor_probe_samples')).rows[0].count,'0')
  result=await readCarrierHistory(owner,1,'7d',{now:new Date(+start+4*86400000)})
  assert.equal(result.carriers[0].sent,10)
  await maintainMonitorHistory({now:new Date(+start+8*86400000)})
  assert.equal((await pool.query('SELECT COUNT(*) FROM monitor_probe_rollups WHERE step=300')).rows[0].count,'0')
  result=await readCarrierHistory(owner,1,'30d',{now:new Date(+start+8*86400000)})
  assert.equal(result.carriers[0].sent,10);assert.equal(result.carriers[0].lossPercent,10)
  await maintainMonitorHistory({now:new Date(+start+31*86400000)})
  assert.equal((await pool.query('SELECT COUNT(*) FROM monitor_probe_rollups')).rows[0].count,'0')
})

test('rollup + raw live tail count once and maintenance failure never prunes source rows',async()=>{
  const start=new Date('2026-10-01T00:00:00Z'),now=new Date(+start+12*60000)
  await pool.query("INSERT INTO monitor_probe_credentials(node_id,user_id,token_hash) VALUES(1,$1,$2)",[owner,'a'.repeat(64)])
  for(const minute of [1,6,11])await pool.query(`INSERT INTO monitor_probe_samples(node_id,carrier,observed_at,address,sent,received,avg_ms,min_ms,max_ms) VALUES(1,'cu',$1,'192.0.2.1',5,5,100,90,110)`,[new Date(+start+minute*60000)])
  await maintainMonitorHistory({now})
  const r=await readCarrierHistory(owner,1,'3d',{now})
  assert.equal(r.carriers[0].sent,15);assert.equal(r.carriers[0].rounds,3)
  let deletes=0
  await assert.rejects(maintainMonitorHistory({now,transaction:fn=>fn({query:async sql=>{
    if(sql.includes('pg_try_advisory'))return {rows:[{locked:true}]}
    if(sql.startsWith('SELECT *'))return {rows:[]}
    if(sql.startsWith('INSERT INTO monitor_probe_rollups'))throw Error('disk full')
    if(sql.startsWith('DELETE'))deletes++
    return {rows:[]}
  }})}))
  assert.equal(deletes,0)
  user={id:owner,role:'admin'}
  assert.equal((await app.inject('/api/monitor/nodes/1/carriers?range=30d')).statusCode,200)
  user={id:'22222222-2222-4222-8222-222222222222',role:'admin'}
  assert.equal((await app.inject('/api/monitor/nodes/1/carriers?range=30d')).statusCode,403)
})

test('maintenance serializes across API processes and refuses clock regression',async()=>{
  const holder=await pool.connect()
  try{
    await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(864210052)')
    assert.deepEqual(await maintainMonitorHistory(),{skipped:true})
  }finally{await holder.query('ROLLBACK');holder.release()}
  const now=new Date('2026-10-01T12:00:00Z')
  await maintainMonitorHistory({now})
  const before=(await pool.query('SELECT * FROM monitor_probe_maintenance')).rows
  assert.deepEqual(await maintainMonitorHistory({now:new Date(+now-3600000)}),{skipped:true})
  assert.deepEqual((await pool.query('SELECT * FROM monitor_probe_maintenance')).rows,before)
})
