import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import { MonitorBridge, loadMonitorConfig, monitorError, monitorJson } from './monitorBridge.js'

export const CARRIERS = Object.freeze([
  { id: 'cu', name: '联通', host: 'cu.skrskr.net' },
  { id: 'cm', name: '移动', host: 'cm.skrskr.net' },
  { id: 'ct', name: '电信', host: 'ct.skrskr.net' }
])
export const HUB_FIELDS = ['price','currency','billing_cycle','expires_at','group','notify']
export const DETAIL_FIELDS = ['provider','purpose','tags','links','renewalMode','billingDate']
const cycles = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12, biennial: 24, triennial: 36 }
let connection
const snapshots = new WeakMap()
export function invalidateNodeSnapshot(bridge){snapshots.delete(bridge)}
export async function monitorForUser(userId, { load = () => loadMonitorConfig(config.managedIntegrationsDir), fetcher } = {}) {
  const settings = await load()
  if (!settings) throw monitorError('MONITOR_DISABLED', 404)
  if (settings.ownerUserId !== userId) throw monitorError('OWNER_REQUIRED', 403)
  if (!connection || JSON.stringify(connection.settings) !== JSON.stringify(settings)) connection = new MonitorBridge(settings, fetcher)
  return connection
}
export async function readNodes(bridge, { fresh = false, timeoutMs = 8000 } = {}) {
  const cached = snapshots.get(bridge)
  if (!fresh && cached?.until > Date.now()) return cached.nodes
  const response = await bridge.request('/nodes', { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) { await response.body?.cancel(); throw monitorError('MONITOR_UNAVAILABLE') }
  const data = await monitorJson(response, 2 * 1024 * 1024)
  if (!Array.isArray(data.nodes) || data.admin !== true) throw monitorError('MONITOR_UNAVAILABLE')
  snapshots.set(bridge, { nodes: data.nodes, until: Date.now() + 4000 })
  return data.nodes
}
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null
export function nodeState(node, details = {}) {
  return Object.fromEntries([...HUB_FIELDS.map(key => [key, node[key] ?? (key === 'expires_at' ? null : '')]), ...DETAIL_FIELDS.map(key => [key, details[key] ?? (['tags','links'].includes(key) ? [] : key==='billingDate'?null:'')])])
}
function date(value) {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) throw monitorError('MONITOR_DATE_INVALID',400)
  return value
}
export function normalizeMonitorPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => ![...HUB_FIELDS,...DETAIL_FIELDS].includes(key))) throw monitorError('MONITOR_FIELDS_INVALID',400)
  const out = {}
  for (const [key,value] of Object.entries(input)) {
    if (['expires_at','billingDate'].includes(key)) out[key] = date(value)
    else if (key === 'price') {
      if (numeric(value) === null || value < 0 || value > 1000000) throw monitorError('MONITOR_FIELDS_INVALID',400)
      out[key] = value
    } else if (key === 'notify') {
      if (typeof value !== 'boolean') throw monitorError('MONITOR_FIELDS_INVALID',400)
      out[key] = value
    } else if (key === 'tags') {
      if (!Array.isArray(value) || value.length > 12 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 40)) throw monitorError('MONITOR_FIELDS_INVALID',400)
      out[key] = [...new Set(value.map(v=>v.trim()))]
    } else if (key === 'links') {
      if (!Array.isArray(value) || value.length > 8) throw monitorError('MONITOR_FIELDS_INVALID',400)
      out[key] = value.map(item => {
        let url; try { url = new URL(item.url) } catch { throw monitorError('MONITOR_LINK_INVALID',400) }
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 1000 || typeof item.title !== 'string' || item.title.length > 80) throw monitorError('MONITOR_LINK_INVALID',400)
        return { title: item.title.trim(), url: url.href }
      })
    } else {
      if (typeof value !== 'string' || value.length > (key === 'purpose' ? 500 : 80) || /[\x00-\x1f\x7f]/.test(value)) throw monitorError('MONITOR_FIELDS_INVALID',400)
      out[key] = value.trim()
      if (key === 'currency' && !/^[A-Z]{3}$/.test(out[key])) throw monitorError('MONITOR_FIELDS_INVALID',400)
      if (key === 'billing_cycle' && ![...Object.keys(cycles),'once'].includes(out[key]) && !/^([1-9]|[1-9][0-9]|1[01][0-9]|120)m$/.test(out[key])) throw monitorError('MONITOR_FIELDS_INVALID',400)
      if (key === 'billing_cycle') out[key] = Object.entries(cycles).find(([,months])=>`${months}m`===out[key])?.[0] || out[key]
      if (key === 'renewalMode' && !['','manual','auto','cancel'].includes(out[key])) throw monitorError('MONITOR_FIELDS_INVALID',400)
    }
  }
  return out
}
export function probeSummary(rows, now = Date.now()) {
  return CARRIERS.map(carrier => {
    const samples = rows.filter(row => row.carrier === carrier.id).sort((a,b)=>new Date(b.observed_at)-new Date(a.observed_at))
    const latest = samples[0], valid = samples.filter(row => !row.error && row.sent > 0)
    const sent = valid.reduce((n,r)=>n+Number(r.sent),0), received = valid.reduce((n,r)=>n+Number(r.received),0)
    const weighted = valid.filter(r=>r.received > 0 && numeric(r.avg_ms) !== null)
    const successes = weighted.reduce((n,r)=>n+Number(r.received),0)
    return { ...carrier, protocol:'ICMP', direction:'服务器 → 运营商目标',
      status: !latest ? 'unconfigured' : now-new Date(latest.received_at).getTime() > 180000 ? 'stale' : latest.error ? 'error' : 'current',
      observedAt: latest?.observed_at || null, address: latest?.address || null, error: latest?.error || null,
      latencyMs: latest && !latest.error ? numeric(latest.avg_ms) : null,
      averageMs: successes ? weighted.reduce((n,r)=>n+r.avg_ms*r.received,0)/successes : null,
      sent, received, lossPercent: sent ? (sent-received)*100/sent : null,
      samples: samples.length, missingSamples: samples.filter(r=>r.error).length,
      points: [...samples].reverse().map(r=>({ at:r.observed_at, ms:r.error ? null : r.avg_ms, loss:!r.error&&r.sent ? (r.sent-r.received)*100/r.sent : null })) }
  })
}
export function overview(nodes, details, probes, now = Date.now(), credentials = []) {
  const costs = {}, alerts = []
  const items = nodes.map(node => {
    const detail = details.find(d=>Number(d.node_id)===node.id)?.details || {}
    const credential = credentials.find(c=>Number(c.node_id)===node.id)
    const m = node.metrics, fresh = node.online && node.last_seen_ago !== null && node.last_seen_ago <= 30
    const ratio = (used,total) => numeric(used)!==null && numeric(total)>0 ? used*100/total : null
    const cpu = fresh ? numeric(m?.cpu) : null, memory = fresh ? ratio(m?.mem_used,m?.mem_total) : null, disk = fresh ? ratio(m?.disk_used,m?.disk_total) : null
    const traffic = ratio(node.month_used,node.traffic_limit)
    const expiryDays = numeric(node.expires_in)
    if (!node.online) alerts.push({ nodeId:node.id, kind:'offline', text:`${node.name} 已离线` })
    if (expiryDays !== null && expiryDays <= 30) alerts.push({ nodeId:node.id, kind:'expiry', text:`${node.name} ${expiryDays < 0 ? '已过到期日' : `${expiryDays} 天后到期`}` })
    if (traffic >= 80) alerts.push({ nodeId:node.id, kind:'traffic', text:`${node.name} 本周期流量已用 ${traffic.toFixed(0)}%` })
    if (memory >= 85 || disk >= 85) alerts.push({ nodeId:node.id,kind:'capacity',text:`${node.name} ${disk >= 85 ? '磁盘' : '内存'}使用率较高` })
    const months = cycles[node.billing_cycle] || Number(/^(\d+)m$/.exec(node.billing_cycle)?.[1])
    if (node.price > 0 && months) costs[node.currency] = (costs[node.currency] || 0) + node.price / months
    // Explicit allowlist: never return Agent tokens or the private upstream remark.
    return { id:node.id,name:node.name,country:node.country,online:node.online,fresh,lastSeenAgo:node.last_seen_ago,
      ipv4:node.ipv4||node.ip||'',ipv6:node.ipv6||'',os:node.os,cpuName:node.cpu_name,cores:node.cpu_cores,agentVersion:node.agent_version,
      ...nodeState(node,detail),expiryDays,cpu,memory,disk,load:fresh?m?.load:null,uptime:fresh?m?.uptime:null,
      memoryTotal:node.mem_total,diskTotal:node.disk_total,rx:fresh?numeric(m?.net_rx):null,tx:fresh?numeric(m?.net_tx):null,
      trafficUsed:node.month_used,trafficLimit:node.traffic_limit,trafficMode:node.traffic_mode,trafficPercent:traffic,
      carriers:probeSummary(probes.filter(p=>Number(p.node_id)===node.id),now).map(c=>({...c,status:c.status==='unconfigured'&&credential?'stale':c.status})),
      services:credential?.services||[],servicesAt:credential?.last_report_at||null }
  })
  return { nodes:items,alerts,costs,generatedAt:new Date(now).toISOString(),probeWindowMinutes:1,refreshSeconds:15 }
}
export async function monitorOverview(userId, bridge, queryFn = query) {
  const [nodes, details, probes, credentials] = await Promise.all([
    readNodes(bridge), queryFn('SELECT node_id,details FROM monitor_node_details WHERE user_id=$1',[userId]),
    queryFn(`SELECT s.* FROM monitor_probe_credentials c CROSS JOIN (VALUES ('cu'),('cm'),('ct')) v(carrier)
      CROSS JOIN LATERAL (SELECT * FROM monitor_probe_samples p WHERE p.node_id=c.node_id AND p.carrier=v.carrier ORDER BY p.observed_at DESC LIMIT 1) s
      WHERE c.user_id=$1 AND c.enabled`,[userId]),
    queryFn('SELECT node_id,services,last_report_at FROM monitor_probe_credentials WHERE user_id=$1 AND enabled',[userId])
  ])
  return overview(nodes,details.rows,probes.rows,Date.now(),credentials.rows)
}
export async function searchMonitor(userId, search, queryFn = query) {
  let bridge; try { bridge=await monitorForUser(userId) } catch (e) { if (['MONITOR_DISABLED','OWNER_REQUIRED'].includes(e.code)) return []; throw e }
  // Global search needs asset fields, not a full hour of probe history. A failed
  // monitor must not hold up bookmarks and notes for the normal bridge timeout.
  const [nodes,details]=await Promise.all([readNodes(bridge,{timeoutMs:2000}),queryFn('SELECT node_id,details FROM monitor_node_details WHERE user_id=$1',[userId])])
  const data=overview(nodes,details.rows,[]), terms=String(search).toLowerCase().split(/\s+/).filter(Boolean)
  return data.nodes.filter(n=>terms.every(t=>`${n.name} ${n.ipv4} ${n.ipv6} ${n.country} ${n.group} ${n.provider} ${n.purpose} ${n.tags.join(' ')}`.toLowerCase().includes(t))).slice(0,20).map(n=>({
    id:String(n.id),kind:'server',kindLabel:'服务器',title:n.name,href:`/monitor?node=${n.id}`,score:100,
    snippet:`${n.online?'在线':'离线'} · ${n.group||n.country||'未分组'} · 到期 ${n.expires_at||'未录入'} · ${n.provider} ${n.purpose}`,updatedAt:data.generatedAt,
    matchReasons:['监控资产'],metrics:{cpu:n.cpu,memory:n.memory,disk:n.disk},expiresAt:n.expires_at
  }))
}
export async function proposeMonitorChange(userId,bridge,nodeId,input,queryFn=query,expected) {
  nodeId=Number(nodeId)
  if (!Number.isSafeInteger(nodeId)||nodeId<1||nodeId>2147483647) throw monitorError('MONITOR_NODE_INVALID',400)
  const patch=normalizeMonitorPatch(input), node=(await readNodes(bridge,{fresh:true})).find(n=>n.id===nodeId)
  if (!node) throw monitorError('MONITOR_NODE_INVALID',404)
  const result=await queryFn('SELECT details FROM monitor_node_details WHERE user_id=$1 AND node_id=$2',[userId,nodeId])
  const before=nodeState(node,result.rows[0]?.details)
  if (expected!==undefined && (!expected || typeof expected!=='object' || Array.isArray(expected) || Object.keys(patch).some(key=>!same(before[key],expected[key])))) throw monitorError('MONITOR_CHANGE_CONFLICT',409)
  const change={id:randomUUID(),nodeId,name:node.name,before,patch,status:'preview'}
  await queryFn(`INSERT INTO monitor_changes(id,user_id,node_id,before_state,patch,status) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,'preview')`,[change.id,userId,nodeId,JSON.stringify(before),JSON.stringify(patch)])
  return {...change,href:`/monitor?node=${nodeId}&change=${change.id}`}
}
// PostgreSQL JSONB changes object-key order. Equality must ignore that order.
const same=isDeepStrictEqual
export async function confirmMonitorChange(userId,bridge,id,transaction=withTransaction) {
  // Durable claim precedes the network write. A lost response never causes an automatic replay.
  const change=await transaction(async client=>{
    const {rows}=await client.query('SELECT * FROM monitor_changes WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])
    const row=rows[0]; if(!row) throw monitorError('MONITOR_CHANGE_MISSING',404)
    if(row.status==='applied') return row
    if(row.status!=='preview'||new Date(row.expires_at)<new Date()) throw monitorError('MONITOR_CHANGE_REVIEW',409)
    await client.query("SELECT pg_advisory_xact_lock(hashtext('monitor-node'),$1::int)",[Number(row.node_id)])
    const busy=await client.query("SELECT 1 FROM monitor_changes WHERE user_id=$1 AND node_id=$2 AND status IN ('applying','uncertain') LIMIT 1",[userId,row.node_id])
    if(busy.rowCount) throw monitorError('MONITOR_CHANGE_REVIEW',409)
    const node=(await readNodes(bridge,{fresh:true})).find(n=>n.id===Number(row.node_id))
    const details=await client.query('SELECT details FROM monitor_node_details WHERE user_id=$1 AND node_id=$2',[userId,row.node_id])
    if(!node||!same(nodeState(node,details.rows[0]?.details),row.before_state)) throw monitorError('MONITOR_CHANGE_CONFLICT',409)
    await client.query("UPDATE monitor_changes SET status='applying',started_at=NOW() WHERE id=$1",[id]); return row
  })
  if(change.status==='applied') return {id,status:'applied',replayed:true}
  const patch=normalizeMonitorPatch(change.patch), hub=Object.fromEntries(Object.entries(patch).filter(([k])=>HUB_FIELDS.includes(k)))
  try {
    if(Object.keys(hub).length){
      const res=await bridge.request(`/nodes/${change.node_id}`,{method:'PUT',contentType:'application/json',body:JSON.stringify(hub)})
      await res.body?.cancel(); if(!res.ok) throw monitorError('MONITOR_CHANGE_REVIEW',409)
      const node=(await readNodes(bridge,{fresh:true})).find(n=>n.id===Number(change.node_id))
      if(!node||Object.entries(hub).some(([k,v])=>!same(node[k],v))) throw monitorError('MONITOR_CHANGE_REVIEW',409)
    }
    await transaction(async client=>{
      const details=Object.fromEntries(DETAIL_FIELDS.map(k=>[k,patch[k]!==undefined?patch[k]:change.before_state[k]]))
      await client.query(`INSERT INTO monitor_node_details(user_id,node_id,details) VALUES($1,$2,$3::jsonb) ON CONFLICT(user_id,node_id) DO UPDATE SET details=EXCLUDED.details,updated_at=NOW()`,[userId,change.node_id,JSON.stringify(details)])
      await client.query("UPDATE monitor_changes SET status='applied',applied_at=NOW() WHERE id=$1",[id])
    })
    return {id,status:'applied'}
  }catch{
    await transaction(client=>client.query("UPDATE monitor_changes SET status='uncertain' WHERE id=$1",[id])).catch(()=>{})
    throw monitorError('MONITOR_CHANGE_REVIEW',409)
  }
}
export function validateProbeReport(body,now=Date.now()) {
  if(!body||!Number.isSafeInteger(body.nodeId)||body.nodeId<1||!Array.isArray(body.samples)||body.samples.length!==3||Math.abs(now-new Date(body.observedAt).getTime())>300000||!Number.isFinite(new Date(body.observedAt).getTime())) throw monitorError('MONITOR_PROBE_INVALID',400)
  const seen=new Set()
  for(const s of body.samples){
    if(!s||!CARRIERS.some(c=>c.id===s.carrier)||seen.has(s.carrier)||!Number.isInteger(s.sent)||s.sent<0||s.sent>5||!Number.isInteger(s.received)||s.received<0||s.received>s.sent) throw monitorError('MONITOR_PROBE_INVALID',400)
    seen.add(s.carrier)
    if(s.error){if(!['dns','permission','tool','timeout','parse','target'].includes(s.error)||s.sent!==0||s.received!==0) throw monitorError('MONITOR_PROBE_INVALID',400)}
    else if(s.sent!==5||!s.address) throw monitorError('MONITOR_PROBE_INVALID',400)
    if(s.address&&isIP(s.address)!==4) throw monitorError('MONITOR_PROBE_INVALID',400)
    for(const k of ['avgMs','minMs','maxMs']) if(s[k]!==null&&(numeric(s[k])===null||s[k]<0||s[k]>=60000)) throw monitorError('MONITOR_PROBE_INVALID',400)
    if(s.received>0&&(s.avgMs===null||s.minMs===null||s.maxMs===null||s.minMs>s.avgMs||s.avgMs>s.maxMs)) throw monitorError('MONITOR_PROBE_INVALID',400)
    if(s.received===0&&[s.avgMs,s.minMs,s.maxMs].some(v=>v!==null)) throw monitorError('MONITOR_PROBE_INVALID',400)
  }
  if(body.services!==undefined&&(!Array.isArray(body.services)||body.services.length>8||body.services.some(s=>!s||typeof s.unit!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9@_.-]{0,79}\.service$/.test(s.unit)||!['active','inactive','failed','activating','unknown'].includes(s.status)))) throw monitorError('MONITOR_PROBE_INVALID',400)
  return body
}
export const probeTokenHash=token=>createHash('sha256').update(token).digest('hex')
