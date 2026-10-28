import test from 'node:test'
import assert from 'node:assert/strict'
import { carrierSeries,historyCache,invalidateMonitorCache,readCarrierHistory,HISTORY_RANGES } from '../src/lib/monitorHistory.js'
const from=new Date('2026-10-01T00:00:00Z'),to=new Date(+from+300000)
test('long histories weight packets and received latency, while errors lower coverage without inventing loss',()=>{
 const base={carrier:'cu',at:from,first_at:from,last_at:from,addresses:['192.0.2.1'],min_ms:100,max_ms:250}
 const result=carrierSeries([{...base,sent:'5',received:'4',rtt_sum:'800',rounds:1,valid_rounds:1},{...base,at:to,sent:'5',received:'5',rtt_sum:'500',rounds:2,valid_rounds:1}],{range:'1h',step:60,from,to}).carriers[0]
 assert.equal(result.lossPercent,10);assert.equal(result.averageMs,1300/9);assert.equal(result.coverage,40);assert.equal(result.errorRounds,1);assert.equal(result.maxMs,250)
 const empty=carrierSeries([],{range:'30d',step:3600,from,to}).carriers[0]
 assert.equal(empty.lossPercent,null);assert.equal(empty.averageMs,null);assert.equal(empty.coverage,0)
})
test('coalesced caches isolate owners, expire failed reads, and invalidate after writes',async()=>{
 let count=0;const read=async()=>++count
 const values=await Promise.all([historyCache('owner-a:history',read),historyCache('owner-a:history',read),historyCache('owner-b:history',read)])
 assert.deepEqual(values,[1,1,2]);invalidateMonitorCache('owner-a');assert.equal(await historyCache('owner-a:history',read),3)
 await assert.rejects(historyCache('owner-c:error',async()=>{throw Error('offline')}));assert.equal(await historyCache('owner-c:error',read),4)
})
test('history has bounded ranges and verifies ownership before reading any samples',async()=>{
 let reads=0
 await assert.rejects(readCarrierHistory('x',1,'365d',{queryFn:()=>{reads++;throw Error()}}),e=>e.statusCode===400)
 assert.equal(reads,0)
 const result=await readCarrierHistory('x',1,'30d',{queryFn:async(sql,params)=>{reads++;assert.match(sql,/user_id=\$1/);assert.equal(params[0],'x');return {rows:[]}}})
 assert.equal(reads,1);assert.deepEqual(result.carriers,[]);assert.equal(HISTORY_RANGES['30d'][1],3600)
})
