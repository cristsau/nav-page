import { query, withTransaction } from '../db/index.js'
import { monitorError } from './monitorBridge.js'

export const HISTORY_RANGES = Object.freeze({ '1h':[3600,60], '24h':[86400,60], '3d':[259200,300], '7d':[604800,900], '30d':[2592000,3600] })
const fields='sent,received,rtt_sum,min_ms,max_ms,rounds,valid_rounds,first_at,last_at'
const sumFields='SUM(sent) AS sent,SUM(received) AS received,SUM(rtt_sum) AS rtt_sum,MIN(min_ms) AS min_ms,MAX(max_ms) AS max_ms,SUM(rounds)::int AS rounds,SUM(valid_rounds)::int AS valid_rounds,MIN(first_at) AS first_at,MAX(last_at) AS last_at'
const updateFields=fields.split(',').map(k=>`${k}=EXCLUDED.${k}`).join(',')

// One bounded transaction: roll up before pruning. A crashed or competing worker
// cannot advance the cursor or remove the only copy of a sample.
export async function maintainMonitorHistory({transaction=withTransaction,now=new Date()}={}) {
  return transaction(async client=>{
    await client.query("SET LOCAL statement_timeout='30s'")
    const lock=await client.query('SELECT pg_try_advisory_xact_lock(864210052) AS locked')
    if(!lock.rows[0].locked)return {skipped:true}
    const state=(await client.query('SELECT * FROM monitor_probe_maintenance WHERE id=TRUE')).rows[0]
    const end=new Date(Math.floor((+now-300000)/300000)*300000)
    if(state&&+end<+new Date(state.watermark))return {skipped:true}
    const start=state?new Date(+new Date(state.watermark)-600000):new Date(Math.floor((+now-3*86400000-3600000)/300000)*300000)
    await client.query(`INSERT INTO monitor_probe_rollups(node_id,carrier,step,bucket,address,${fields})
      SELECT node_id,carrier,300,date_bin('5 minutes',observed_at,'2000-01-01'::timestamptz),COALESCE(host(address),''),
        SUM(CASE WHEN error IS NULL THEN sent ELSE 0 END),SUM(CASE WHEN error IS NULL THEN received ELSE 0 END),
        SUM(CASE WHEN error IS NULL THEN COALESCE(avg_ms,0)*received ELSE 0 END),
        MIN(CASE WHEN error IS NULL THEN min_ms END),MAX(CASE WHEN error IS NULL THEN max_ms END),
        COUNT(*)::int,COUNT(*) FILTER(WHERE error IS NULL AND sent>0)::int,MIN(observed_at),MAX(observed_at)
      FROM monitor_probe_samples WHERE observed_at >= $1 AND observed_at < $2
      GROUP BY node_id,carrier,4,5
      ON CONFLICT(node_id,carrier,step,bucket,address) DO UPDATE SET ${updateFields}`,[start,end])
    const hourStart=new Date(Math.floor(+start/3600000)*3600000),hourEnd=new Date(Math.floor(+end/3600000)*3600000)
    await client.query(`INSERT INTO monitor_probe_rollups(node_id,carrier,step,bucket,address,${fields})
      SELECT node_id,carrier,3600,date_bin('1 hour',bucket,'2000-01-01'::timestamptz),address,${sumFields}
      FROM monitor_probe_rollups WHERE step=300 AND bucket >= $1 AND bucket < $2
      GROUP BY node_id,carrier,4,address
      ON CONFLICT(node_id,carrier,step,bucket,address) DO UPDATE SET ${updateFields}`,[hourStart,hourEnd])
    const prune=!state||+now-+new Date(state.pruned_at)>=3600000
    if(prune){
      await client.query('DELETE FROM monitor_probe_samples WHERE observed_at < $1 AND observed_at < $2',[new Date(+now-3*86400000),end])
      await client.query('DELETE FROM monitor_probe_rollups WHERE (step=300 AND bucket < $1) OR (step=3600 AND bucket < $2)',[new Date(+now-7*86400000),new Date(+now-30*86400000)])
    }
    await client.query(`INSERT INTO monitor_probe_maintenance(id,watermark,pruned_at) VALUES(TRUE,$1,$2)
      ON CONFLICT(id) DO UPDATE SET watermark=EXCLUDED.watermark,pruned_at=EXCLUDED.pruned_at`,[end,prune?now:state.pruned_at])
    return {watermark:end,pruned:prune}
  })
}

export function startMonitorHistory({logger,run=maintainMonitorHistory,intervalMs=300000}={}) {
  let stopped=false,timer,active
  const tick=()=>{active=run().catch(()=>logger?.warn('Monitor history maintenance deferred')).finally(()=>{active=null;if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.()}})}
  timer=setTimeout(tick,5000);timer.unref?.()
  return async()=>{stopped=true;clearTimeout(timer);await active}
}

// Shared within one API process, never across users; in-flight reads are coalesced.
const cached=new Map()
export function invalidateMonitorCache(userId){for(const key of cached.keys())if(key.startsWith(`${userId}:`))cached.delete(key)}
export function historyCache(key,read,ttl=55000) {
  const existing=cached.get(key)
  if(existing?.until>Date.now())return existing.value
  const entry={until:Date.now()+ttl,value:null}
  entry.value=Promise.resolve().then(read).catch(e=>{if(cached.get(key)===entry)cached.delete(key);throw e})
  cached.set(key,entry)
  if(cached.size>128)cached.delete(cached.keys().next().value)
  return entry.value
}

export async function readCarrierHistory(userId,nodeId,range,{queryFn=query,now=new Date()}={}) {
  if(!HISTORY_RANGES[range])throw monitorError('MONITOR_FIELDS_INVALID',400)
  const [duration,step]=HISTORY_RANGES[range],from=new Date(+now-duration*1000)
  const credential=(await queryFn('SELECT node_id FROM monitor_probe_credentials WHERE user_id=$1 AND node_id=$2 AND enabled',[userId,nodeId])).rows[0]
  if(!credential)return {range,step,from,to:now,carriers:[]}
  const state=(await queryFn('SELECT watermark FROM monitor_probe_maintenance WHERE id=TRUE')).rows[0]
  const sourceStep=range==='30d'?3600:300
  // If maintenance is behind, fresh raw samples bridge its exact committed watermark.
  const boundary=state?new Date(Math.floor(+new Date(state.watermark)/(sourceStep*1000))*sourceStep*1000):from
  const useRollup=step>=300
  const result=await queryFn(`WITH samples AS (
      SELECT carrier,observed_at AS at,COALESCE(host(address),'') AS address,
        CASE WHEN error IS NULL THEN sent ELSE 0 END AS sent,CASE WHEN error IS NULL THEN received ELSE 0 END AS received,
        CASE WHEN error IS NULL THEN COALESCE(avg_ms,0)*received ELSE 0 END AS rtt_sum,
        CASE WHEN error IS NULL THEN min_ms END AS min_ms,CASE WHEN error IS NULL THEN max_ms END AS max_ms,
        1 AS rounds,CASE WHEN error IS NULL AND sent>0 THEN 1 ELSE 0 END AS valid_rounds,observed_at AS first_at,observed_at AS last_at
      FROM monitor_probe_samples WHERE node_id=$1 AND observed_at >= $2 AND observed_at <= $3 AND (NOT $6 OR observed_at >= $5)
      UNION ALL
      SELECT carrier,bucket AS at,address,${fields} FROM monitor_probe_rollups
      WHERE node_id=$1 AND step=$4 AND bucket >= $2 AND bucket < $5 AND $6
    ) SELECT carrier,date_bin(($7::text||' seconds')::interval,at,'2000-01-01'::timestamptz) AS at,
      ${sumFields},array_agg(DISTINCT address) AS addresses
      FROM samples GROUP BY carrier,2 ORDER BY 2`,[nodeId,from,now,sourceStep,boundary,useRollup,step])
  return carrierSeries(result.rows,{range,step,from,to:now})
}

export function carrierSeries(rows,{range,step,from,to}) {
  const carriers=['cu','cm','ct'].map(id=>{
    const samples=rows.filter(r=>r.carrier===id)
    const sum=key=>samples.reduce((v,r)=>v+Number(r[key]||0),0)
    const count=key=>sum(key)
    const transmitted=count('sent'),received=count('received'),rounds=count('rounds'),valid=count('valid_rounds')
    const expected=Math.max(1,Math.ceil((+new Date(to)-+new Date(from))/60000))
    const points=samples.map(r=>({at:r.at,ms:Number(r.received)>0?Number(r.rtt_sum)/Number(r.received):null,
      loss:Number(r.sent)>0?(Number(r.sent)-Number(r.received))*100/Number(r.sent):null,
      max:Number.isFinite(Number(r.max_ms))&&r.max_ms!==null?Number(r.max_ms):null,addresses:r.addresses,coverage:Math.min(100,Number(r.valid_rounds)*60/step*100)}))
    const maximum=samples.filter(r=>r.max_ms!==null).map(r=>Number(r.max_ms))
    return {id,sent:transmitted,received,rounds,validRounds:valid,errorRounds:rounds-valid,
      coverage:Math.min(100,valid/expected*100),averageMs:received?count('rtt_sum')/received:null,
      maxMs:maximum.length?Math.max(...maximum):null,lossPercent:transmitted?(transmitted-received)*100/transmitted:null,
      availableFrom:samples[0]?.first_at||null,points}
  })
  return {range,step,from,to,carriers}
}
