import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { query, withTransaction } from '../db/index.js'
import { monitorError } from './monitorBridge.js'
import { monitorForUser, proposeMonitorChange, confirmMonitorChange, readNodes, nodeState } from './monitorWorkspace.js'
import { invalidateMonitorCache } from './monitorHistory.js'
import { stableJson } from './offlineMutations.js'

export const MONITOR_TOOL = 'prepare_monitor_change'
export function monitorOperationReceipt(row) {
  return { id:row.operation_id, operationId:row.operation_id, tool:MONITOR_TOOL, status:row.status,
    summary:row.result_summary||{}, confirmationId:row.arguments?.changeId, preview:row.preview, href:row.preview?.href, expiresAt:row.expires_at,
    undoSupported:row.status==='succeeded', undoUntil:null, createdAt:row.created_at }
}
export async function proposeAssistantMonitor({ userId, operationId, conversationId, messageId, nodeId, patch, candidateIds, bridge, transaction=withTransaction }) {
  if (!candidateIds.includes(`monitor:${nodeId}`)) throw monitorError('MONITOR_CANDIDATE_REQUIRED',409)
  const hash = createHash('sha256').update(stableJson({nodeId,patch})).digest('hex')
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('assistant-monitor'),hashtext($1))",[`${userId}:${operationId}`])
    const old = (await client.query('SELECT o.*,p.arguments,p.preview,p.expires_at FROM assistant_agent_operations o JOIN assistant_agent_operation_payloads p USING(user_id,operation_id) WHERE o.user_id=$1 AND o.operation_id=$2',[userId,operationId])).rows[0]
    if(old){if(old.tool_name!==MONITOR_TOOL||old.arguments_hash!==hash)throw monitorError('MONITOR_CHANGE_CONFLICT',409);return {receipt:monitorOperationReceipt(old),result:{status:old.status}}}
    const owned = await client.query('SELECT 1 FROM assistant_messages WHERE id=$1 AND user_id=$2 AND conversation_id=$3',[messageId,userId,conversationId])
    if(!owned.rowCount)throw monitorError('MONITOR_CHANGE_MISSING',404)
    const change = await proposeMonitorChange(userId,bridge,nodeId,patch,client.query.bind(client))
    const preview={target:change.name,nodeId,href:change.href,changes:Object.entries(patch).map(([field,value])=>({field,before:change.before[field],after:value}))}
    const row=(await client.query(`INSERT INTO assistant_agent_operations(user_id,operation_id,conversation_id,message_id,tool_name,tool_version,risk,authorization_mode,arguments_hash,status,result_summary) VALUES($1,$2,$3,$4,$5,1,'risky','confirmation',$6,'awaiting_confirmation',$7::jsonb) RETURNING *`,[userId,operationId,conversationId,messageId,MONITOR_TOOL,hash,JSON.stringify({target:change.name})])).rows[0]
    const payload=(await client.query(`INSERT INTO assistant_agent_operation_payloads(user_id,operation_id,arguments,preview,confirmation_fingerprint,expires_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,NOW()+interval '15 minutes') RETURNING *`,[userId,operationId,JSON.stringify({changeId:change.id,nodeId}),JSON.stringify(preview),hash])).rows[0]
    return {receipt:monitorOperationReceipt({...row,...payload}),result:{status:'awaiting_confirmation',message:'修改尚未保存，请用户核对卡片后点击确认。'}}
  })
}
export async function mutateAssistantMonitor(userId, operationId, kind, {expectedChangeId,queryFn=query,transaction=withTransaction,getBridge=monitorForUser,confirm=confirmMonitorChange}={}) {
  const row=(await queryFn('SELECT o.*,p.arguments,p.preview,p.expires_at FROM assistant_agent_operations o JOIN assistant_agent_operation_payloads p USING(user_id,operation_id) WHERE o.user_id=$1 AND o.operation_id=$2',[userId,operationId])).rows[0]
  if(!row||row.tool_name!==MONITOR_TOOL)throw monitorError('MONITOR_CHANGE_MISSING',404)
  if(!expectedChangeId||expectedChangeId!==row.arguments.changeId)throw monitorError('MONITOR_CHANGE_CONFLICT',409)
  const bridge=await getBridge(userId)
  if(kind==='undo') {
    return transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext('assistant-monitor'),hashtext($1))",[`${userId}:${operationId}`])
      const current=(await client.query('SELECT status,arguments FROM assistant_agent_operations JOIN assistant_agent_operation_payloads USING(user_id,operation_id) WHERE user_id=$1 AND operation_id=$2',[userId,operationId])).rows[0]
      if(current?.status!=='succeeded'||current.arguments.undo||current.arguments.changeId!==expectedChangeId)throw monitorError('MONITOR_CHANGE_REVIEW',409)
      const change=(await client.query("SELECT * FROM monitor_changes WHERE id=$1 AND user_id=$2 AND status='applied'",[current.arguments.changeId,userId])).rows[0]
      if(!change)throw monitorError('MONITOR_CHANGE_REVIEW',409)
      const node=(await readNodes(bridge,{fresh:true})).find(n=>n.id===Number(change.node_id))
      const details=(await client.query('SELECT details FROM monitor_node_details WHERE user_id=$1 AND node_id=$2',[userId,change.node_id])).rows[0]?.details
      const state=node&&nodeState(node,details)
      if(!state||Object.entries(change.patch).some(([k,v])=>!isDeepStrictEqual(state[k],v)))throw monitorError('MONITOR_CHANGE_CONFLICT',409)
      const patch=Object.fromEntries(Object.keys(change.patch).map(k=>[k,change.before_state[k]]))
      const undo=await proposeMonitorChange(userId,bridge,change.node_id,patch,client.query.bind(client),state)
      const preview={target:undo.name,nodeId:undo.nodeId,href:undo.href,changes:Object.entries(patch).map(([field,after])=>({field,before:state[field],after})),undo:true}
      await client.query("UPDATE assistant_agent_operations SET status='awaiting_confirmation',updated_at=NOW() WHERE user_id=$1 AND operation_id=$2",[userId,operationId])
      await client.query("UPDATE assistant_agent_operation_payloads SET arguments=$3::jsonb,preview=$4::jsonb,expires_at=NOW()+interval '15 minutes' WHERE user_id=$1 AND operation_id=$2",[userId,operationId,JSON.stringify({changeId:undo.id,nodeId:undo.nodeId,undo:true}),JSON.stringify(preview)])
      return {receipt:monitorOperationReceipt({...row,arguments:{changeId:undo.id},status:'awaiting_confirmation',preview,expires_at:new Date(Date.now()+900000)})}
    })
  }
  if(kind==='cancel') {
    await transaction(async client=>{
      const cancelled=await client.query("UPDATE monitor_changes SET status='cancelled' WHERE user_id=$1 AND id=$2 AND status='preview' RETURNING id",[userId,row.arguments.changeId])
      if(!cancelled.rowCount)throw monitorError('MONITOR_CHANGE_REVIEW',409)
      await client.query("UPDATE assistant_agent_operations SET status='cancelled',updated_at=NOW() WHERE user_id=$1 AND operation_id=$2",[userId,operationId])
    })
    return {receipt:monitorOperationReceipt({...row,status:'cancelled'})}
  }
  if(kind!=='confirm'||!['awaiting_confirmation','succeeded','undone'].includes(row.status))throw monitorError('MONITOR_CHANGE_REVIEW',409)
  try {
    await confirm(userId,bridge,row.arguments.changeId)
    const status=row.arguments.undo?'undone':'succeeded'
    const saved=await queryFn(`UPDATE assistant_agent_operations o SET status=$3,completed_at=NOW(),updated_at=NOW() FROM assistant_agent_operation_payloads p WHERE o.user_id=$1 AND o.operation_id=$2 AND p.user_id=o.user_id AND p.operation_id=o.operation_id AND p.arguments->>'changeId'=$4 RETURNING o.operation_id`,[userId,operationId,status,row.arguments.changeId])
    if(!saved.rowCount)throw monitorError('MONITOR_CHANGE_CONFLICT',409)
    return {receipt:monitorOperationReceipt({...row,status})}
  } finally {invalidateMonitorCache(userId)}
}
