import { query, withTransaction } from '../db/index.js'
import { monitorError,monitorJson } from '../lib/monitorBridge.js'
import { monitorOverview,proposeMonitorChange,confirmMonitorChange,validateProbeReport,probeTokenHash,HUB_FIELDS,DETAIL_FIELDS,readNodes,nodeState,monitorForUser } from '../lib/monitorWorkspace.js'
import { interpretMonitor } from '../lib/monitorAi.js'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import { historyCache, readCarrierHistory, invalidateMonitorCache } from '../lib/monitorHistory.js'

const uuid=id=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id||'')
export async function registerMonitorWorkspace(app,handler) {
  app.get('/monitor/overview',handler((bridge,req)=>historyCache(`${req.currentUser.id}:overview`,()=>monitorOverview(req.currentUser.id,bridge),8000)))
  app.get('/monitor/nodes/:id/carriers',handler(async(_bridge,req)=>{
    if(!/^\d{1,9}$/.test(req.params.id))throw monitorError('MONITOR_NODE_INVALID',400)
    const range=req.query.range||'1h'
    return historyCache(`${req.currentUser.id}:carriers:${req.params.id}:${range}`,()=>readCarrierHistory(req.currentUser.id,Number(req.params.id),range))
  }))
  app.get('/monitor/nodes/:id/history',handler(async(bridge,req)=>{
    if(!/^\d{1,9}$/.test(req.params.id)) throw monitorError('MONITOR_NODE_INVALID',400)
    const hours=[1,6,24,168].includes(Number(req.query.hours))?Number(req.query.hours):6
    const series=req.query.series==='ping'?'ping':'metrics'
    return historyCache(`${req.currentUser.id}:resources:${req.params.id}:${hours}:${series}`,async()=>{
      const response=await bridge.request(`/nodes/${req.params.id}/metrics?hours=${hours}&points=120&series=${series}`,{signal:AbortSignal.timeout(10000)})
      if(!response.ok){await response.body?.cancel();throw monitorError('MONITOR_UNAVAILABLE')}
      return monitorJson(response,2*1024*1024)
    },55000)
  }))
  app.get('/monitor/nodes/:id/changes',handler(async(_bridge,req)=>{
    if(!/^\d{1,9}$/.test(req.params.id)) throw monitorError('MONITOR_NODE_INVALID',400)
    const {rows}=await query(`SELECT id,node_id,before_state,patch,status,created_at,expires_at,applied_at FROM monitor_changes WHERE user_id=$1 AND node_id=$2 ORDER BY created_at DESC LIMIT 30`,[req.currentUser.id,req.params.id])
    return {changes:rows}
  }))
  app.post('/monitor/nodes/:id/proposals',handler((bridge,req)=>proposeMonitorChange(req.currentUser.id,bridge,req.params.id,req.body?.patch,query,req.body?.expected)))
  app.post('/monitor/changes/:id/confirm',handler(async(bridge,req)=>{
    if(!uuid(req.params.id)||req.body?.confirmed!==true) throw monitorError('MONITOR_FIELDS_INVALID',400)
    try{return await confirmMonitorChange(req.currentUser.id,bridge,req.params.id)}finally{invalidateMonitorCache(req.currentUser.id)}
  }))
  app.post('/monitor/changes/:id/undo-preview',handler(async(bridge,req)=>{
    if(!uuid(req.params.id)) throw monitorError('MONITOR_FIELDS_INVALID',400)
    const row=(await query("SELECT * FROM monitor_changes WHERE user_id=$1 AND id=$2 AND status='applied'",[req.currentUser.id,req.params.id])).rows[0]
    if(!row) throw monitorError('MONITOR_CHANGE_MISSING',404)
    const node=(await readNodes(bridge,{fresh:true})).find(n=>n.id===Number(row.node_id))
    const details=(await query('SELECT details FROM monitor_node_details WHERE user_id=$1 AND node_id=$2',[req.currentUser.id,row.node_id])).rows[0]?.details
    const state=node&&nodeState(node,details)
    if(!state||Object.entries(row.patch).some(([key,value])=>JSON.stringify(state[key])!==JSON.stringify(value))) throw monitorError('MONITOR_CHANGE_CONFLICT',409)
    return proposeMonitorChange(req.currentUser.id,bridge,row.node_id,Object.fromEntries(Object.keys(row.patch).map(key=>[key,row.before_state[key]])))
  }))
  app.post('/monitor/changes/:id/reconcile',handler(async(bridge,req)=>{
    if(!uuid(req.params.id)) throw monitorError('MONITOR_FIELDS_INVALID',400)
    // Resolve interrupted writes by readback only. Never issue another hub write.
    return withTransaction(async client=>{
      const row=(await client.query('SELECT * FROM monitor_changes WHERE user_id=$1 AND id=$2 FOR UPDATE',[req.currentUser.id,req.params.id])).rows[0]
      if(!row||!['uncertain','applying'].includes(row.status)) throw monitorError('MONITOR_CHANGE_REVIEW',409)
      if(row.status==='applying'&&Date.now()-new Date(row.started_at||row.created_at).getTime()<120000) throw monitorError('MONITOR_CHANGE_REVIEW',409)
      const node=(await readNodes(bridge,{fresh:true})).find(n=>n.id===Number(row.node_id))
      const fields=Object.keys(row.patch).filter(k=>HUB_FIELDS.includes(k))
      if(!node) throw monitorError('MONITOR_NODE_INVALID',404)
      const applied=fields.every(k=>JSON.stringify(node[k])===JSON.stringify(row.patch[k]))
      const untouched=fields.every(k=>JSON.stringify(node[k])===JSON.stringify(row.before_state[k]))
      if(!applied&&!untouched) throw monitorError('MONITOR_CHANGE_CONFLICT',409)
      if(applied){
        const details=Object.fromEntries(DETAIL_FIELDS.map(k=>[k,row.patch[k]!==undefined?row.patch[k]:row.before_state[k]]))
        await client.query(`INSERT INTO monitor_node_details(user_id,node_id,details) VALUES($1,$2,$3::jsonb) ON CONFLICT(user_id,node_id) DO UPDATE SET details=EXCLUDED.details,updated_at=NOW()`,[req.currentUser.id,row.node_id,JSON.stringify(details)])
      }
      const status=applied?'applied':'cancelled'
      await client.query('UPDATE monitor_changes SET status=$2,applied_at=CASE WHEN $2=\'applied\' THEN NOW() ELSE NULL END WHERE id=$1',[row.id,status])
      return {id:row.id,status}
    })
  }))
  app.post('/monitor/nodes/:id/ai',{bodyLimit:5*1024*1024},handler(async(bridge,req,reply)=>{
    const limited=await enforceAiRateLimit(req,reply);if(limited)return limited
    const data=await monitorOverview(req.currentUser.id,bridge),node=data.nodes.find(n=>n.id===Number(req.params.id))
    if(!node) throw monitorError('MONITOR_NODE_INVALID',404)
    return interpretMonitor(req.currentUser.id,node,req.body)
  }))
  app.post('/monitor/probes/report',{bodyLimit:8192},async(req,reply)=>{
    reply.header('Cache-Control','no-store')
    try{
      const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'')?.[1]
      if(!token) return reply.code(401).send({error:'Invalid probe credential'})
      const body=validateProbeReport(req.body)
      return await withTransaction(async client=>{
        const credential=(await client.query('SELECT * FROM monitor_probe_credentials WHERE node_id=$1 AND token_hash=$2 AND enabled FOR UPDATE',[body.nodeId,probeTokenHash(token)])).rows[0]
        if(!credential) return reply.code(401).send({error:'Invalid probe credential'})
        await monitorForUser(credential.user_id)
        if(credential.last_report_at&&Date.now()-new Date(credential.last_report_at).getTime()<45000) return reply.code(429).send({error:'Report interval is 60 seconds'})
        for(const s of body.samples) await client.query(`INSERT INTO monitor_probe_samples(node_id,carrier,observed_at,address,sent,received,avg_ms,min_ms,max_ms,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[body.nodeId,s.carrier,body.observedAt,s.address||null,s.sent,s.received,s.avgMs,s.minMs,s.maxMs,s.error||null])
        await client.query('UPDATE monitor_probe_credentials SET last_report_at=NOW(),services=$2::jsonb WHERE node_id=$1',[body.nodeId,JSON.stringify(body.services||[])])
        return {ok:true}
      })
    }catch(e){return reply.code(e.statusCode===400?400:503).send({error:e.statusCode===400?'Invalid report':'Probe reporting unavailable'})}
  })
}
