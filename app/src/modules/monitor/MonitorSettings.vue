<script setup>
import { ref,onMounted,onBeforeUnmount,watch } from 'vue'
import Modal from '@/shared/components/Modal.vue'
import { apiRequest,apiFileRequest } from '@/shared/services/apiClient'
const emit=defineEmits(['close'])
const section=ref('nodes'),nodes=ref([]),tasks=ref([]),settings=ref({}),baseline=ref({}),busy=ref(false),loading=ref(true),error=ref(''),notice=ref(''),selection=ref([]),batchGroup=ref('')
const edit=ref(null),editBase=ref(null),probe=ref(null),confirmation=ref(null),token=ref(''),credentialNode=ref(null),db=ref(null),registration=ref(null),newName=ref('')
const controller=new AbortController(),GIB=1024**3
let disposed=false
const api=(path,options={})=>apiRequest('/monitor/admin'+path,{...options,signal:controller.signal})
const json=(method,value)=>({method,body:JSON.stringify(value)})
const nodeFields=[['name','名称'],['group','分组'],['country_pin','国家 / 地区代码'],['ipv4_pin','固定显示 IPv4'],['ipv6_pin','固定显示 IPv6'],['remark','私密备注']]
const notifications=[['notify_telegram_token','Bot Token','password'],['notify_telegram_chat','Chat ID','text'],['notify_telegram_text','Telegram 模板','text'],['notify_webhook_url','Webhook URL','password'],['notify_webhook_headers','Webhook 请求头','password'],['notify_webhook_body','Webhook JSON 模板','text'],['notify_grace','离线宽限期（分钟）','number'],['notify_traffic','流量提醒阈值（%）','number'],['notify_expiry','提前提醒到期（天）','number']]
async function run(action,message='已保存'){
  if(busy.value)return
  busy.value=true;error.value='';notice.value=''
  try{await action();if(!disposed)notice.value=message}
  catch{if(!disposed)error.value='操作未确认完成，请刷新核对后再操作。'}
  finally{busy.value=false}
}
async function load(){
  loading.value=true;error.value=''
  try{
    if(section.value==='nodes'){nodes.value=(await api('/nodes')).nodes;selection.value=selection.value.filter(id=>nodes.value.some(n=>n.id===id))}
    if(section.value==='notify'){settings.value=await api('/settings');baseline.value=JSON.parse(JSON.stringify(settings.value))}
    if(section.value==='probes'){[tasks.value,nodes.value]=await Promise.all([api('/ping-tasks').then(r=>r.tasks),api('/nodes').then(r=>r.nodes)])}
    if(section.value==='data'){[db.value,settings.value]=await Promise.all([api('/db'),api('/settings')]);baseline.value=JSON.parse(JSON.stringify(settings.value))}
  }catch{if(!disposed)error.value='设置暂不可用，请重试。'}finally{loading.value=false}
}
function ask(title,description,action){confirmation.value={title,description,action}}
async function confirm(){const item=confirmation.value;confirmation.value=null;await run(item.action)}
function beginNode(n){token.value='';credentialNode.value=null;edit.value={...n,limitGiB:String(n.traffic_limit/GIB||0),correction:{}};editBase.value={...edit.value}}
async function saveNode(){
  const n=edit.value,base=editBase.value,patch={}
  if(!n.name.trim())return error.value='请填写名称。'
  for(const key of [...nodeFields.map(f=>f[0]),'notify','traffic_mode','traffic_reset_day'])if(n[key]!==base[key])patch[key]=n[key]
  if(n.limitGiB!==base.limitGiB)patch.traffic_limit=Math.round(Number(n.limitGiB)*GIB)
  const correction=Object.fromEntries(Object.entries(n.correction).filter(([,v])=>String(v).trim()!=='').map(([k,v])=>[k,Math.round(Number(v)*GIB)]))
  if([patch.traffic_limit,...Object.values(correction)].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||v<0)))return error.value='请填写有效的非负流量。'
  if(n.traffic_reset_day<1||n.traffic_reset_day>31)return error.value='重置日为 1–31。'
  const save=async()=>{if(Object.keys(patch).length)await api(`/nodes/${n.id}`,json('PUT',patch));if(Object.keys(correction).length)await api(`/nodes/${n.id}/traffic`,json('PUT',correction));edit.value=null;await load()}
  if(Object.keys(correction).length)ask('校正流量计数','将覆盖填写的流量计数，留空的项目保持不变。',save)
  else await run(save)
}
async function reorder(items,index,delta,path){const ids=items.map(n=>n.id),other=index+delta;if(other<0||other>=ids.length)return;[ids[index],ids[other]]=[ids[other],ids[index]];await run(async()=>{await api(`/${path}/order`,json('PUT',{ids}));await load()})}
async function batch(patch){if(!selection.value.length)return;await run(async()=>{await api('/nodes/batch',json('PUT',{ids:selection.value,patch}));await load()})}
function beginProbe(task){probe.value=task?{...task,nodes:[...task.nodes],base:[...task.nodes]}:{name:'',target:'',interval:60,nodes:[],auto_join:false}}
async function saveProbe(){const p=probe.value;if(!p.name.trim()||!p.target.trim()||!Number.isInteger(p.interval)||p.interval<5||p.interval>3600)return error.value='请填写名称、主机:端口，以及 5–3600 秒间隔。';await run(async()=>{await api('/ping-tasks',json('POST',p));probe.value=null;await load()})}
async function saveNotifications(){
  const patch={};for(const key of [...notifications.map(f=>f[0]),'notify_login']){const value=String(settings.value[key]??'');if(value!==String(baseline.value[key]??''))patch[key]=value}
  if(Object.keys(patch).length)await run(async()=>{await api('/settings',json('PUT',patch));await load()})
}
async function exportDatabase(){await run(async()=>{const {blob}=await apiFileRequest('/monitor/admin/db/backup',{signal:controller.signal});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`monitor-${new Date().toISOString().slice(0,10)}.sqlite`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},'备份已生成')}
async function reveal(n){await run(async()=>{credentialNode.value=n;token.value=(await api(`/nodes/${n.id}/token`)).token},'')}
async function copyToken(){try{await navigator.clipboard.writeText(token.value);notice.value='已复制'}catch{error.value='复制失败，请手动复制。'}}
async function copyRegistration(){try{await navigator.clipboard.writeText(registration.value.register_key);notice.value='已复制'}catch{error.value='复制失败。'}}
watch(section,()=>{edit.value=null;probe.value=null;token.value='';credentialNode.value=null;registration.value=null;notice.value='';load()})
onMounted(load)
onBeforeUnmount(()=>{disposed=true;controller.abort();token.value='';settings.value={};registration.value=null})
</script>
<template>
  <Modal :show="true" title="监控设置" width="1000px" :close-disabled="busy" @close="emit('close')">
    <div class="monitor-settings">
      <nav class="settings-tabs"><button v-for="[key,title] in [['nodes','节点管理'],['notify','通知'],['probes','探测任务'],['data','数据管理']]" :key="key" :aria-pressed="section===key" :disabled="busy" @click="section=key">{{title}}</button></nav>
      <p v-if="error" class="error" role="alert">{{error}} <button :disabled="busy" @click="load">刷新</button></p><p v-if="notice" role="status">{{notice}}</p>
      <div v-if="loading" role="status" class="empty">正在加载…</div>
      <template v-else-if="section==='nodes'">
        <div class="settings-actions"><input v-model="newName" maxlength="64" placeholder="新节点名称" aria-label="新节点名称"/><button :disabled="busy||!newName.trim()" @click="run(async()=>{await api('/nodes',json('POST',{name:newName.trim(),public:false}));newName='';await load()})">添加节点</button><button :disabled="busy" @click="run(async()=>{const s=await api('/settings');registration={register_left:s.register_left,register_key:s.register_key}},'')">批量接入</button></div>
        <section v-if="registration" class="settings-card"><h3>自动注册</h3><p>{{registration.register_left>0?'注册窗口已开启':'注册窗口已关闭'}}</p><input v-if="registration.register_key" type="password" readonly :value="registration.register_key" aria-label="临时注册密钥"/><button v-if="registration.register_key" @click="copyRegistration">复制注册密钥</button><button :disabled="busy" @click="ask('开启注册窗口','持有临时密钥的服务器可在限时窗口内加入。',async()=>{registration=await api('/register-window',{method:'POST'})})">开启窗口</button><button :disabled="busy||!registration.register_key" @click="run(async()=>{await api('/register-window',{method:'DELETE'});registration=null})">关闭窗口</button></section>
        <div v-if="selection.length" class="settings-actions"><span>已选 {{selection.length}} 台</span><input v-model="batchGroup" maxlength="80" placeholder="分组名称" aria-label="批量分组"/><button :disabled="busy" @click="batch({group:batchGroup})">设置分组</button><button :disabled="busy" @click="batch({notify:true})">开启提醒</button><button :disabled="busy" @click="batch({notify:false})">关闭提醒</button></div>
        <div v-for="(n,index) in nodes" :key="n.id" class="settings-row"><label><input type="checkbox" v-model="selection" :value="n.id" :aria-label="`选择 ${n.name}`"/><strong>{{n.name}}</strong><small>{{n.group||'未分组'}}</small></label><div class="settings-actions"><button :disabled="busy||index===0" :aria-label="`上移 ${n.name}`" @click="reorder(nodes,index,-1,'nodes')">↑</button><button :disabled="busy||index===nodes.length-1" :aria-label="`下移 ${n.name}`" @click="reorder(nodes,index,1,'nodes')">↓</button><button :disabled="busy" @click="beginNode(n)">编辑</button><button :disabled="busy" @click="reveal(n)">接入凭据</button><button class="danger" :disabled="busy" @click="ask(`删除 ${n.name}`, '删除节点及其监控历史，服务器上的程序不会卸载。',async()=>{await api(`/nodes/${n.id}`,{method:'DELETE'});await load()})">删除</button></div></div>
        <section v-if="credentialNode" class="settings-card"><h3>{{credentialNode.name}} · 接入凭据</h3><p>服务地址：https://node.cvv.gr</p><input type="password" :value="token" readonly aria-label="节点令牌"/><button @click="copyToken">复制令牌</button><button :disabled="busy" @click="ask('轮换节点令牌','当前 Agent 会断开，更新该服务器凭据后才会重新连接。',async()=>{token=(await api(`/nodes/${credentialNode.id}/token`,{method:'POST'})).token})">轮换令牌</button><button @click="credentialNode=null;token=''">关闭</button></section>
        <form v-if="edit" class="settings-card form-grid" @submit.prevent="saveNode"><h3 class="wide">编辑 {{editBase.name}}</h3><label v-for="[key,title] in nodeFields" :key="key">{{title}}<input v-model="edit[key]" :maxlength="key==='remark'?2000:80"/></label><label>流量额度（GiB）<input v-model="edit.limitGiB" type="number" min="0" step="any"/></label><label>计费方向<select v-model="edit.traffic_mode"><option value="sum">双向合计</option><option value="up">上传</option><option value="down">下载</option><option value="max">较大方向</option></select></label><label>每月重置日<input v-model.number="edit.traffic_reset_day" type="number" min="1" max="31"/></label><label class="check"><input v-model="edit.notify" type="checkbox"/>离线与恢复提醒</label><details class="wide"><summary>校正流量计数</summary><div class="form-grid"><label v-for="[key,title] in [['month_rx','本周期下载'],['month_tx','本周期上传'],['total_rx','累计下载'],['total_tx','累计上传']]" :key="key">{{title}}（GiB）<input v-model="edit.correction[key]" type="number" min="0" step="any" placeholder="留空保持不变"/></label></div></details><div class="wide settings-actions"><button type="button" :disabled="busy" @click="edit=null">取消</button><button class="primary" :disabled="busy" type="submit">保存</button></div></form>
      </template>
      <form v-else-if="section==='notify'" class="form-grid" @submit.prevent="saveNotifications"><label v-for="[key,title,type] in notifications" :key="key">{{title}}<input v-model="settings[key]" :type="type" autocomplete="off" :placeholder="settings[key+'_set']?'已配置，留空保持不变':''"/></label><label>登录提醒<select v-model="settings.notify_login"><option value="on">开启</option><option value="off">关闭</option></select></label><div class="wide settings-actions"><button class="primary" :disabled="busy" type="submit">保存通知设置</button><button type="button" :disabled="busy" @click="ask('发送测试通知','将向已配置的通知渠道发送一条测试消息。',async()=>{await api('/notify/test',{method:'POST'})})">测试通知</button><button type="button" :disabled="busy" @click="ask('清除 Telegram','将停止 Telegram 通知。',async()=>{await api('/settings',json('PUT',{notify_telegram_token:'',notify_telegram_chat:''}));await load()})">清除 Telegram</button><button type="button" :disabled="busy" @click="ask('清除 Webhook','将停止 Webhook 通知。',async()=>{await api('/settings',json('PUT',{notify_webhook_url:'',notify_webhook_headers:''}));await load()})">清除 Webhook</button></div></form>
      <template v-else-if="section==='probes'"><div class="settings-actions"><button :disabled="busy" @click="beginProbe()">新建 TCP 探测</button></div><div v-for="(t,index) in tasks" :key="t.id" class="settings-row"><div><strong>{{t.name}}</strong><small>{{t.target}} · {{t.interval}} 秒 · {{t.nodes.length}} 台</small></div><div class="settings-actions"><button :disabled="busy||index===0" @click="reorder(tasks,index,-1,'ping-tasks')">↑</button><button :disabled="busy||index===tasks.length-1" @click="reorder(tasks,index,1,'ping-tasks')">↓</button><button :disabled="busy" @click="beginProbe(t)">编辑</button><button class="danger" :disabled="busy" @click="ask(`删除 ${t.name}`,'此探测将停止。',async()=>{await api(`/ping-tasks/${t.id}`,{method:'DELETE'});await load()})">删除</button></div></div><p v-if="!tasks.length" class="empty">暂无 TCP 探测任务</p><form v-if="probe" class="settings-card form-grid" @submit.prevent="saveProbe"><label>名称<input v-model="probe.name" maxlength="64" required/></label><label>主机:端口<input v-model="probe.target" placeholder="example.com:443" required/></label><label>间隔（秒）<input v-model.number="probe.interval" type="number" min="5" max="3600" required/></label><label class="check"><input v-model="probe.auto_join" type="checkbox"/>自动加入新节点</label><div class="wide node-picker"><label v-for="n in nodes" :key="n.id" class="check"><input v-model="probe.nodes" type="checkbox" :value="n.id"/>{{n.name}}</label></div><div class="wide settings-actions"><button type="button" :disabled="busy" @click="probe=null">取消</button><button class="primary" :disabled="busy" type="submit">保存探测</button></div></form></template>
      <template v-else-if="section==='data'"><section class="settings-card"><h3>三网历史</h3><p>分钟明细 3 天 · 5 分钟汇总 7 天 · 小时汇总 30 天</p></section><section class="settings-card"><h3>资源历史</h3><form class="settings-actions" @submit.prevent="run(async()=>{await api('/settings',json('PUT',{retention_days:String(settings.retention_days)}));await load()})"><label>保留天数 <input v-model="settings.retention_days" type="number" min="1" max="365" required/></label><button :disabled="busy" type="submit">保存</button></form><p v-if="db">数据库状态已更新</p></section><div class="settings-actions"><button :disabled="busy" @click="exportDatabase">导出监控数据库</button><button :disabled="busy" @click="ask('整理监控数据库','清理超过保留期的资源历史并回收空间，操作期间管理请求可能变慢。',async()=>{await api('/db/vacuum',{method:'POST'});await load()})">整理空间</button></div></template>
      <Modal :show="Boolean(confirmation)" :title="confirmation?.title||'确认操作'" width="420px" :close-disabled="busy" @close="confirmation=null"><p>{{confirmation?.description}}</p><div class="settings-actions"><button :disabled="busy" @click="confirmation=null">取消</button><button class="primary" :disabled="busy" @click="confirm">确认</button></div></Modal>
    </div>
  </Modal>
</template>
<style scoped>
.monitor-settings{font-size:13px}.settings-tabs,.settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.settings-tabs{border-bottom:1px solid var(--border-color);padding-bottom:12px;margin-bottom:18px}.settings-tabs [aria-pressed=true],.primary{background:var(--accent-bg);color:var(--accent-text)}button,input,select{font:inherit;color:inherit;border:1px solid var(--border-color);border-radius:7px;background:var(--bg-card);padding:9px 12px;max-width:100%;box-sizing:border-box}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid var(--border-color)}.settings-row label{display:flex;align-items:center;gap:8px}.settings-row small{display:block;color:var(--text-secondary);margin-top:4px}.settings-card{border:1px solid var(--border-color);border-radius:9px;padding:18px;margin:18px 0}.settings-card h3{font-size:14px;margin:0 0 14px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.form-grid label{display:flex;flex-direction:column;gap:7px}.wide{grid-column:1/-1}.check{display:flex!important;flex-direction:row!important;align-items:center;gap:7px}.node-picker{display:flex;gap:14px;flex-wrap:wrap}.error,.danger{color:var(--color-danger,#bf5d54)}.empty{padding:32px;color:var(--text-secondary);text-align:center}summary{cursor:pointer;margin-bottom:12px}@media(max-width:650px){.form-grid{grid-template-columns:1fr}.settings-row{align-items:flex-start;flex-direction:column}.settings-actions button{min-height:40px}.settings-row>.settings-actions{width:100%}}
</style>
