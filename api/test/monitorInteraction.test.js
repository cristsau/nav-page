import test from 'node:test'
import assert from 'node:assert/strict'
import { trendGeometry,nearestSample,formatMetric } from '../../app/src/modules/monitor/trendGeometry.js'
import { normalizeMonitorPatch,overview } from '../src/lib/monitorWorkspace.js'
import { proposeAssistantMonitor,mutateAssistantMonitor,monitorOperationReceipt } from '../src/lib/assistantMonitorOperations.js'
import { classifyAssistantIntent } from '../src/lib/assistantIntent.js'
const at=n=>new Date(Date.UTC(2026,9,29,0,n)).toISOString()
test('chart retains real time spacing, zero, missing rounds, address changes and isolated samples',()=>{
  const g=trendGeometry([{at:at(0),ms:0},{at:at(1),ms:30},{at:at(2),ms:null},{at:at(3),ms:20},{at:at(20),ms:50}],{from:at(0),to:at(60),gapSeconds:180})
  assert.equal(g.segments.length,3);assert.equal(g.segments[0][0].v,0)
  assert.equal(g.x(Date.parse(at(30))),228)
  assert.equal(nearestSample(g.data,Date.parse(at(10)),90000),null)
  assert.equal(nearestSample(g.data,Date.parse(at(2)),90000).v,null)
  const changed=trendGeometry([{at:at(0),ms:20,addresses:['192.0.2.1']},{at:at(1),ms:25,addresses:['192.0.2.2']},{at:at(2),ms:30,addresses:['192.0.2.1','192.0.2.2']}])
  assert.equal(changed.segments.length,2);assert.equal(changed.values.length,2)
  assert.equal(formatMetric(null),'无有效采样');assert.equal(formatMetric(1024,'B/s'),'1.0 KiB/s')
})
test('traffic modes, bytes, reset day and country overrides are bounded; unknown usage is never zero',()=>{
  const patch={traffic_limit:200e9,traffic_mode:'max',traffic_reset_day:1,countryOverride:'HK'}
  assert.deepEqual(normalizeMonitorPatch(patch),patch)
  for(const bad of [{traffic_limit:-1},{traffic_limit:1.5},{traffic_limit:2**54},{traffic_mode:'both'},{traffic_reset_day:0},{traffic_reset_day:32},{countryOverride:'UNKNOWN'},{countryOverride:'ZZ'}])assert.throws(()=>normalizeMonitorPatch(bad))
  const n={id:1,name:'Synthetic',country:'JP',month_used:1024,traffic_limit:0,traffic_mode:'sum'}
  const auto=overview([n],[],[]).nodes[0],manual=overview([n],[{node_id:1,details:{countryOverride:'HK'}}],[]).nodes[0]
  assert.equal(auto.trafficUsed,1024);assert.equal(auto.trafficPercent,null);assert.equal(auto.countryCode,'JP');assert.equal(manual.countryCode,'HK')
  assert.equal(overview([{...n,month_used:null}],[],[]).nodes[0].trafficUsed,null)
  assert.equal(classifyAssistantIntent('帮我把 Ali-HK 每月流量额度修改为 200 GB，取单向最大值').action,true)
})
test('assistant cannot propose a server that was not read in this request',async()=>{
  let writes=0
  await assert.rejects(()=>proposeAssistantMonitor({userId:'u',nodeId:2,patch:{price:2},candidateIds:['monitor:1'],transaction:()=>{writes++}}),e=>e.code==='MONITOR_CANDIDATE_REQUIRED')
  assert.equal(writes,0)
})
test('assistant rejects another owner operation before connecting to monitor',async()=>{
  let connections=0
  await assert.rejects(()=>mutateAssistantMonitor('other','id','confirm',{queryFn:async()=>({rows:[]}),getBridge:()=>{connections++}}),e=>e.code==='MONITOR_CHANGE_MISSING')
  assert.equal(connections,0)
})
test('confirmation uses stored change identity; uncertain outcome does not mark success or replay a network write',async()=>{
  const row={operation_id:'op',tool_name:'prepare_monitor_change',status:'awaiting_confirmation',arguments:{changeId:'stored'},preview:{target:'Synthetic'}}
  let updates=0,attempts=0
  const dependencies={expectedChangeId:'stored',queryFn:async sql=>{if(sql.startsWith('UPDATE'))updates++;return {rows:[row],rowCount:1}},getBridge:async()=>({}),confirm:async(_u,_b,id)=>{assert.equal(id,'stored');attempts++;throw Object.assign(Error(),{code:'MONITOR_CHANGE_REVIEW'})}}
  await assert.rejects(()=>mutateAssistantMonitor('owner','op','confirm',dependencies))
  assert.equal(updates,0);assert.equal(attempts,1)
  const done=await mutateAssistantMonitor('owner','op','confirm',{...dependencies,confirm:async()=>({status:'applied',replayed:true})})
  assert.equal(done.receipt.status,'succeeded');assert.equal(done.receipt.undoSupported,true)
  assert.equal(monitorOperationReceipt({...row,status:'cancelled'}).undoSupported,false)
})

test('a delayed confirmation cannot overwrite a newer undo proposal',async()=>{
  const row={operation_id:'op',tool_name:'prepare_monitor_change',status:'awaiting_confirmation',arguments:{changeId:'original'}}
  let writes=0
  await assert.rejects(()=>mutateAssistantMonitor('owner','op','confirm',{
    expectedChangeId:'original',queryFn:async(sql,params)=>{
      if(sql.startsWith('UPDATE')) {writes++;assert.match(sql,/p.arguments->>'changeId'=\$4/);assert.equal(params[3],'original');return {rows:[],rowCount:0}}
      return {rows:[row]}
    },getBridge:async()=>({}),confirm:async()=>({status:'applied',replayed:true})
  }),e=>e.code==='MONITOR_CHANGE_CONFLICT')
  assert.equal(writes,1)
})

test('monitor proposal persists only a preview and replays without another native proposal',async()=>{
  let saved, payload, nativePreviews=0, reads=0
  const bridge={request:async(_path,options)=>{assert.notEqual(options?.method,'PUT');reads++;return new Response(JSON.stringify({admin:true,nodes:[{id:4,name:'Synthetic',traffic_mode:'sum',traffic_limit:0,traffic_reset_day:1}]}))}}
  const client={query:async(sql,args)=>{
    if(sql.includes('pg_advisory'))return {rows:[]}
    if(sql.startsWith('SELECT o.'))return {rows:saved?[{...saved,...payload}]:[]}
    if(sql.startsWith('SELECT 1 FROM assistant_messages'))return {rowCount:1,rows:[{}]}
    if(sql.startsWith('SELECT details'))return {rows:[]}
    if(sql.startsWith('INSERT INTO monitor_changes')){nativePreviews++;return {rows:[]}}
    if(sql.startsWith('INSERT INTO assistant_agent_operations')){saved={operation_id:args[1],tool_name:args[4],arguments_hash:args[5],status:'awaiting_confirmation'};return {rows:[saved]}}
    if(sql.startsWith('INSERT INTO assistant_agent_operation_payloads')){payload={arguments:JSON.parse(args[2]),preview:JSON.parse(args[3]),expires_at:new Date(Date.now()+900000)};assert.match(args[4],/^[a-f0-9]{64}$/);return {rows:[payload]}}
    throw Error('Unexpected preview database access')
  }}
  const input={userId:'owner',operationId:'op',conversationId:'c',messageId:'m',nodeId:4,patch:{traffic_limit:200e9,traffic_mode:'max'},candidateIds:['monitor:4'],bridge,transaction:fn=>fn(client)}
  const first=await proposeAssistantMonitor(input)
  assert.equal(first.receipt.status,'awaiting_confirmation');assert.equal(first.receipt.preview.changes[0].before,0);assert.equal(first.receipt.preview.changes[0].after,200e9)
  assert.match(payload.arguments.changeId,/^[a-f0-9-]{36}$/)
  const replay=await proposeAssistantMonitor(input)
  assert.deepEqual(replay.receipt.preview,first.receipt.preview);assert.equal(nativePreviews,1);assert.equal(reads,1)
  await assert.rejects(()=>proposeAssistantMonitor({...input,patch:{traffic_limit:300e9}}),e=>e.code==='MONITOR_CHANGE_CONFLICT')
})

test('a stale client card cannot confirm a different revision',async()=>{
  let connected=0
  const row={tool_name:'prepare_monitor_change',arguments:{changeId:'undo-revision'},status:'awaiting_confirmation'}
  await assert.rejects(mutateAssistantMonitor('owner','op','confirm',{expectedChangeId:'original-revision',queryFn:async()=>({rows:[row]}),getBridge:async()=>{connected++}}),e=>e.code==='MONITOR_CHANGE_CONFLICT')
  assert.equal(connected,0)
})
