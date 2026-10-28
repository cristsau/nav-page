<script setup>
import { computed,defineAsyncComponent,onBeforeUnmount,onMounted,ref,watch } from 'vue'
import { useRoute,useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import { apiRequest } from '@/shared/services/apiClient'
import MonitorTrend from './MonitorTrend.vue'
const MonitorSettings=defineAsyncComponent(()=>import('./MonitorSettings.vue'))
const route=useRoute(),router=useRouter()
const data=ref(null),loading=ref(true),error=ref(''),notice=ref(''),settingsOpen=ref(false),filter=ref(''),group=ref(''),status=ref('all'),sort=ref('name')
const selectedId=ref(null),tab=ref('metrics'),history=ref(null),historyError=ref(''),hours=ref(6),changes=ref([]),detailError=ref(''),busy=ref(false)
const form=ref({}),editBaseline=ref({}),editing=ref(false),preview=ref(null),aiText=ref(''),aiImage=ref(''),aiFileName=ref(''),aiResult=ref(null),aiBusy=ref(false)
let timer,controller,detailController,aiController,disposed=false,detailsSequence=0
const carrierRange=ref('1h'),carrierHistory=ref(null),carrierError=ref(''),carrierLoading=ref(false),chartMode=ref('ms')
const ranges=[['1h','1 小时'],['24h','24 小时'],['3d','3 天'],['7d','7 天'],['30d','30 天']]
let carrierTimer,carrierController
const carrierCards=computed(()=>(selected.value?.carriers||[]).map(c=>({...c,averageMs:null,lossPercent:null,points:[],...carrierHistory.value?.carriers?.find(h=>h.id===c.id)})))
const selected=computed(()=>data.value?.nodes.find(n=>n.id===selectedId.value))
const groups=computed(()=>[...new Set((data.value?.nodes||[]).map(n=>n.group).filter(Boolean))].sort())
const nodes=computed(()=>{
  const text=filter.value.trim().toLowerCase()
  return (data.value?.nodes||[]).filter(n=>(!group.value||n.group===group.value)&&(status.value==='all'||(status.value==='online'?n.online:status.value==='offline'?!n.online:n.expiryDays!==null&&n.expiryDays<=30))&&`${n.name} ${n.ipv4} ${n.provider} ${n.purpose} ${n.group} ${n.tags.join(' ')}`.toLowerCase().includes(text)).slice().sort((a,b)=>sort.value==='expiry'?(a.expiryDays??Infinity)-(b.expiryDays??Infinity):sort.value==='memory'?(b.memory??-1)-(a.memory??-1):sort.value==='traffic'?(b.trafficPercent??-1)-(a.trafficPercent??-1):a.name.localeCompare(b.name))
})
const online=computed(()=>data.value?.nodes.filter(n=>n.online).length||0)
const expiring=computed(()=>data.value?.nodes.filter(n=>n.expiryDays!==null&&n.expiryDays<=30).length||0)
const costs=computed(()=>Object.entries(data.value?.costs||{}).map(([currency,amount])=>`${currency} ${amount.toFixed(2)}`).join(' / ')||'尚未录入')
const labels={price:'周期费用',currency:'币种',billing_cycle:'计费周期',expires_at:'到期日期',billingDate:'账单日期',provider:'供应商',purpose:'用途',group:'分组',notify:'到期/流量/离线提醒',tags:'标签',links:'关联服务',renewalMode:'续费方式'}
const cycles={monthly:'月付',quarterly:'季付',semiannual:'半年',yearly:'年付',biennial:'两年',triennial:'三年',once:'一次性'}
const probeStatuses={unconfigured:'未接入',stale:'采样已中断',error:'探测异常',current:'采样中'}
const probeErrors={dns:'域名解析失败',permission:'ICMP 权限不足',tool:'缺少 ping 程序',timeout:'探测超时中断',parse:'采样结果无法解析',target:'目标不是公网地址'}
const serviceStatuses={active:'运行中',inactive:'未运行',failed:'失败',activating:'启动中',unknown:'未知'}
const changeStatuses={preview:'待确认',applying:'提交中 · 待核对',applied:'已保存',conflict:'存在冲突',uncertain:'结果待核对',cancelled:'已取消'}
const pct=v=>Number.isFinite(v)?`${v.toFixed(1)}%`:'—'
const ms=v=>Number.isFinite(v)?`${v.toFixed(1)} ms`:'—'
function bytes(n){if(!Number.isFinite(n))return '—';if(n===0)return '0 B';const u=Math.min(4,Math.max(0,Math.floor(Math.log(n)/Math.log(1024))));return `${(n/1024**u).toFixed(u?1:0)} ${['B','KB','MB','GB','TB'][u]}`}
function uptime(value){return Number.isFinite(value)?`${Math.floor(value/86400)} 天 ${Math.floor(value%86400/3600)} 小时`:'—'}
function time(value){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—'}
function display(key,value){if(value===null||value==='')return '未设置';if(key==='billing_cycle')return cycles[value]||value;if(typeof value==='boolean')return value?'开启':'关闭';if(Array.isArray(value))return value.map(v=>typeof v==='object'?`${v.title} ${v.url}`:v).join('、')||'未设置';return String(value)}
function metricPoints(key){return (history.value?.metrics||[]).filter(p=>Number.isFinite(Number(p.ts))).map(p=>({at:new Date(Number(p.ts)*1000).toISOString(),ms:p[key]??null}))}
async function load(){
  clearTimeout(timer);if(disposed||document.hidden)return
  controller?.abort();const current=new AbortController();controller=current
  try{const next=await apiRequest('/monitor/overview',{signal:current.signal,cache:'no-store'});if(disposed||current.signal.aborted)return;data.value=next;error.value=''}
  catch(e){if(!current.signal.aborted)error.value=e.message||'监控暂不可用'}
  finally{if(controller===current){loading.value=false;timer=setTimeout(load,error.value?30000:15000)}}
}
function visibility(){if(document.hidden){clearTimeout(timer);clearTimeout(carrierTimer);controller?.abort();carrierController?.abort()}else{load();loadCarriers()}}
function rowOpen(event,id){if(event.target.closest('button,a,input,select,textarea')||window.getSelection()?.toString())return;openNode(id)}
function rowKey(event,id){if(event.target!==event.currentTarget)return;if(['Enter',' '].includes(event.key)){event.preventDefault();openNode(id)}}
async function loadCarriers(){
  clearTimeout(carrierTimer);carrierController?.abort()
  if(!selectedId.value||tab.value!=='metrics'||document.hidden||disposed)return
  const current=new AbortController();carrierController=current;carrierLoading.value=!carrierHistory.value;carrierError.value=''
  try{const next=await apiRequest(`/monitor/nodes/${selectedId.value}/carriers?range=${carrierRange.value}`,{signal:current.signal});if(!current.signal.aborted)carrierHistory.value=next}
  catch(e){if(!current.signal.aborted)carrierError.value='趋势暂不可用'}
  finally{if(carrierController===current){carrierLoading.value=false;if(!disposed){carrierTimer=setTimeout(loadCarriers,60000)}}}
}
function openNode(id){router.replace({query:{...route.query,node:String(id)}})}
function closeNode(){if(busy.value)return;aiController?.abort();const q={...route.query};delete q.node;delete q.change;router.replace({query:q})}
async function loadDetails(){
  if(!selectedId.value||!['metrics','tcp','history'].includes(tab.value))return
  const seq=++detailsSequence,id=selectedId.value;detailController?.abort();detailController=new AbortController();historyError.value='';detailError.value=''
  const results=await Promise.allSettled([['metrics','tcp'].includes(tab.value)?apiRequest(`/monitor/nodes/${id}/history?hours=${hours.value}&series=${tab.value==='tcp'?'ping':'metrics'}`,{signal:detailController.signal}):Promise.resolve(null),tab.value==='history'||route.query.change?apiRequest(`/monitor/nodes/${id}/changes`,{signal:detailController.signal}):Promise.resolve(null)])
  if(seq!==detailsSequence||disposed)return
  if(results[0].status==='fulfilled'){if(results[0].value)history.value=results[0].value}else historyError.value='历史数据暂不可用，可重试。'
  if(results[1].status==='fulfilled'&&results[1].value){
    changes.value=results[1].value.changes
    const pending=changes.value.find(c=>c.id===route.query.change&&c.status==='preview');if(pending){preview.value={...pending,before:pending.before_state};tab.value='edit'}
  }else if(results[1].status==='rejected')detailError.value='维护记录暂不可用。'
}
function beginEdit(){
  const n=selected.value;if(!n)return
  form.value=Object.fromEntries(Object.keys(labels).map(k=>[k,n[k]??'']))
  editBaseline.value=JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(labels).map(k=>[k,n[k]]))))
  form.value.tags=n.tags.join(', ');form.value.links=n.links.map(l=>`${l.title} | ${l.url}`).join('\n');editing.value=true;preview.value=null;detailError.value=''
}
function changedPatch(){
  const n=editBaseline.value,patch={};for(const key of Object.keys(labels)){
    let value=form.value[key]
    if(key==='price')value=Number(value)
    if(['expires_at','billingDate'].includes(key))value=value||null
    if(key==='tags')value=String(value).split(/[,，]/).map(v=>v.trim()).filter(Boolean)
    if(key==='links')value=String(value).split('\n').filter(v=>v.trim()).map(line=>{const index=line.indexOf('|');return {title:index<0?'服务':line.slice(0,index).trim(),url:(index<0?line:line.slice(index+1)).trim()}})
    const before=['expires_at','billingDate'].includes(key)?n[key]||null:n[key]
    if(JSON.stringify(value)!==JSON.stringify(before))patch[key]=value
  }return patch
}
async function propose(){await action(async()=>{const patch=changedPatch();if(!Object.keys(patch).length){detailError.value='没有需要保存的修改。';return}preview.value=await apiRequest(`/monitor/nodes/${selectedId.value}/proposals`,{method:'POST',body:JSON.stringify({patch,expected:editBaseline.value})});editing.value=false})}
async function action(fn){if(busy.value)return;busy.value=true;detailError.value='';try{await fn()}catch(e){detailError.value=e.message||'操作未完成'}finally{busy.value=false}}
async function confirm(){await action(async()=>{await apiRequest(`/monitor/changes/${preview.value.id}/confirm`,{method:'POST',body:JSON.stringify({confirmed:true})});preview.value=null;editing.value=false;notice.value='资料已保存。';await load();await loadDetails()})}
async function undo(row){await action(async()=>{preview.value=await apiRequest(`/monitor/changes/${row.id}/undo-preview`,{method:'POST',body:'{}'});tab.value='edit';editing.value=false})}
async function reconcile(row){await action(async()=>{await apiRequest(`/monitor/changes/${row.id}/reconcile`,{method:'POST',body:'{}'});await load();await loadDetails()})}
async function imageSelected(event){
  const file=event.target.files?.[0];aiImage.value='';aiFileName.value='';aiResult.value=null
  if(!file)return
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>3*1024*1024){detailError.value='请选择 3 MB 以内的 PNG、JPEG 或 WebP。';event.target.value='';return}
  try{aiImage.value=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});aiFileName.value=file.name}catch{detailError.value='图片读取失败，请重新选择。'}
}
async function askAi(mode){
  if(aiBusy.value)return;aiBusy.value=true;detailError.value='';aiResult.value=null;const id=selectedId.value,current=new AbortController();aiController=current
  try{const result=await apiRequest(`/monitor/nodes/${id}/ai`,{method:'POST',body:JSON.stringify({mode,text:aiText.value,image:mode==='extract'?aiImage.value:undefined}),signal:current.signal});if(id===selectedId.value&&!current.signal.aborted)aiResult.value=result}
  catch(e){if(!current.signal.aborted)detailError.value=e.message||'AI 暂不可用'}finally{if(aiController===current)aiBusy.value=false}
}
function useExtraction(){beginEdit();Object.assign(form.value,aiResult.value.patch);tab.value='edit';notice.value='已填入表单，尚未保存。请核对服务器和日期。'}
watch(()=>route.query.node,value=>{
  selectedId.value=/^\d+$/.test(String(value||''))?Number(value):null
  aiController?.abort();detailController?.abort();detailsSequence++;history.value=null;changes.value=[];editing.value=false;preview.value=null;tab.value='metrics';aiImage.value='';aiFileName.value='';aiResult.value=null;aiText.value='';detailError.value=''
  carrierHistory.value=null;carrierError.value='';loadCarriers();if(selectedId.value)loadDetails()
},{immediate:true})
watch(hours,loadDetails)
watch(carrierRange,()=>{carrierHistory.value=null;loadCarriers()})
watch(tab,()=>{loadDetails();loadCarriers()})
onMounted(()=>{load();document.addEventListener('visibilitychange',visibility)})
onBeforeUnmount(()=>{disposed=true;clearTimeout(timer);clearTimeout(carrierTimer);carrierController?.abort();controller?.abort();detailController?.abort();aiController?.abort();document.removeEventListener('visibilitychange',visibility)})
</script>

<template>
  <main class="monitor-workspace">
    <header class="page-head"><div><h1>服务器</h1></div><div class="tools"><span v-if="data" class="updated">{{error?'数据待刷新':`更新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN')}`}}</span><button @click="settingsOpen=true"><Icon name="settings" :size="16"/>监控设置</button><button :disabled="loading" aria-label="刷新监控" @click="load"><Icon name="refresh" :size="17"/></button></div></header>
    <MonitorSettings v-if="settingsOpen" @close="settingsOpen=false;load()"/>
    <template v-if="true">
      <div v-if="notice" class="notice" role="status">{{notice}}<button aria-label="关闭提示" @click="notice=''">×</button></div>
      <div v-if="error" class="error" role="alert">{{error}} <span v-if="data">当前显示上次结果。</span><button @click="load">重试</button></div>
      <div v-if="loading&&!data" class="loading" role="status">正在读取监控数据…</div>
      <template v-if="data">
        <section class="summary" aria-label="服务器概览"><button @click="status='all'"><span>全部服务器</span><strong>{{data.nodes.length}}</strong><small>{{online}} 在线 · {{data.nodes.length-online}} 离线</small></button><button @click="status='expiry'"><span>30 天内到期</span><strong>{{expiring}}</strong></button><div><span>月均费用</span><strong class="cost">{{costs}}</strong><small title="按原币种统计，不含一次性费用">按周期折算</small></div><div><span>三网采样</span><strong>ICMP <em>60 秒</em></strong><small>后台持续检测</small></div></section>
        <details v-if="data.alerts.length" class="alerts"><summary><Icon name="alert" :size="16"/> {{data.alerts.length}} 项需要关注 <span>到期、离线、流量与容量</span></summary><div class="alert-list"><button v-for="(item,i) in data.alerts" :key="i" @click="openNode(item.nodeId)">{{item.text}} <span>查看 →</span></button></div></details>
        <section class="toolbar" aria-label="筛选服务器"><label class="search"><Icon name="search" :size="18"/><input v-model="filter" placeholder="搜索名称、IP、供应商、用途或标签" aria-label="搜索服务器"/></label><select v-model="group" aria-label="服务器分组"><option value="">全部分组</option><option v-for="g in groups" :key="g">{{g}}</option></select><select v-model="status" aria-label="状态筛选"><option value="all">全部状态</option><option value="online">在线</option><option value="offline">离线</option><option value="expiry">即将到期</option></select><select v-model="sort" aria-label="排序"><option value="name">名称排序</option><option value="expiry">到期优先</option><option value="memory">内存占用</option><option value="traffic">流量占用</option></select></section>
        <div v-if="!nodes.length" class="empty">没有匹配的服务器。<button @click="filter='';group='';status='all'">清除筛选</button></div>
        <div v-else class="node-table"><div class="table-head"><span>服务器 / 用途</span><span>CPU · 内存 · 磁盘</span><span>网络 / 本周期</span><span>联通 · 移动 · 电信</span><span>费用 / 到期</span><span/></div>
          <article v-for="n in nodes" :key="n.id" class="node-row" tabindex="0" role="button" :aria-label="`打开 ${n.name} 详情`" @click="rowOpen($event,n.id)" @keydown="rowKey($event,n.id)" :class="{'offline':!n.online}">
            <div class="identity"><button class="node-name" @click="openNode(n.id)"><i :class="n.online?'online':'down'"/>{{n.name}}</button><span class="muted">{{n.provider||n.country||'未录入供应商'}} <b v-if="n.group">· {{n.group}}</b></span><span class="purpose">{{n.purpose||n.ipv4||'暂无用途说明'}}</span><div v-if="n.tags.length" class="tags"><span v-for="t in n.tags.slice(0,3)" :key="t">{{t}}</span></div></div>
            <div class="resources"><div v-for="[label,value] in [['CPU',n.cpu],['内存',n.memory],['磁盘',n.disk]]" :key="label" class="meter"><span>{{label}}</span><div class="bar"><i :class="{'high':value>=85}" :style="{width:`${Math.min(100,value||0)}%`}"/></div><b>{{pct(value)}}</b></div><small v-if="!n.fresh">{{n.online?'等待最新指标':'离线 · 指标不可用'}}</small></div>
            <div class="network"><div>↓ {{bytes(n.rx)}}/s <span>↑ {{bytes(n.tx)}}/s</span></div><strong>{{bytes(n.trafficUsed)}} <small>/ {{n.trafficLimit?bytes(n.trafficLimit):'未设上限'}}</small></strong><span class="muted">{{n.trafficMode==='up'?'按上传':n.trafficMode==='down'?'按下载':n.trafficMode==='max'?'按较大方向':'双向合计'}} · {{pct(n.trafficPercent)}}</span></div>
            <div class="carriers"><div class="carrier-line" v-for="c in n.carriers" :key="c.id" :title="`${c.host} · ${probeStatuses[c.status]} · 最近一轮 ${c.received}/${c.sent} 包`"><span>{{c.name}}</span><b>{{c.status==='current'?ms(c.latencyMs):probeStatuses[c.status]}}</b><em :class="{'loss':c.lossPercent>2}">{{c.lossPercent===null?'—':`${c.lossPercent.toFixed(1)}%`}}</em></div></div>
            <div class="billing"><strong>{{n.price>0?`${n.currency} ${n.price}`:'费用未录入'}}</strong><span>{{cycles[n.billing_cycle]||n.billing_cycle}}</span><span :class="{'due':n.expiryDays!==null&&n.expiryDays<=30}">{{n.expires_at||'到期日未录入'}}</span></div><button class="detail-button" :aria-label="`查看 ${n.name} 详情`" @click="openNode(n.id)"><Icon name="chevron-right" :size="18"/></button>
          </article>
        </div>
        <p class="footnote">{{nodes.length}} 台服务器</p>
      </template>
    </template>
    <Modal :show="Boolean(selectedId)" :title="selected?.name||'服务器详情'" width="1040px" :close-disabled="busy" @close="closeNode">
      <div class="node-detail" v-if="selected">
        <div class="detail-meta"><span :class="selected.online?'live-label':'due'">{{selected.online?'在线':'离线'}}</span><span>{{selected.os}} · {{selected.cores}} 核 · {{bytes(selected.memoryTotal)}} 内存 · {{bytes(selected.diskTotal)}} 磁盘</span><span>{{selected.ipv4}}</span></div>
        <nav class="tabs" aria-label="详情选项"><button v-for="[key,title] in [['metrics','资源与三网'],['tcp','TCP 探测'],['edit','资产资料'],['ai','AI 识图与分析'],['history','维护记录']]" :key="key" :aria-pressed="tab===key" @click="tab=key">{{title}}</button></nav>
        <p v-if="detailError" class="error" role="alert">{{detailError}}</p>
        <div v-if="tab==='metrics'" class="detail-content">
          <dl class="live-stats"><div><dt>CPU</dt><dd>{{pct(selected.cpu)}}</dd></div><div><dt>内存</dt><dd>{{pct(selected.memory)}}</dd></div><div><dt>磁盘</dt><dd>{{pct(selected.disk)}}</dd></div><div><dt>运行时间</dt><dd>{{uptime(selected.uptime)}}</dd></div></dl>
          <div class="section-heading"><h2>三网质量</h2><div class="range-controls"><select v-model="carrierRange" aria-label="三网时间范围"><option v-for="[value,label] in ranges" :key="value" :value="value">{{label}}</option></select><select v-model="chartMode" aria-label="三网图表指标"><option value="ms">平均延迟</option><option value="max">最高延迟</option><option value="loss">丢包率</option></select></div></div>
          <p v-if="carrierError" class="error">{{carrierError}}<button @click="loadCarriers">重试</button></p>
          <div class="carrier-cards" :aria-busy="carrierLoading"><section v-for="c in carrierCards" :key="c.id" class="carrier-card"><header><strong>{{c.name}}</strong><span>{{probeStatuses[c.status]}}</span></header><p class="muted" :title="`${c.host} · ${c.address||''} · IPv4 / ICMP`">{{c.host}}</p><div class="carrier-numbers"><strong>{{carrierLoading?'…':ms(c.averageMs)}}<small>平均延迟</small></strong><strong :class="{'due':c.lossPercent>2}">{{carrierLoading?'…':pct(c.lossPercent)}}<small>丢包率</small></strong></div><div v-if="carrierLoading" class="chart-loading">正在加载趋势…</div><MonitorTrend v-else :points="c.points||[]" :from="carrierHistory?.from" :to="carrierHistory?.to" :value-key="chartMode" :unit="chartMode==='loss'?'%':'ms'" :gap-seconds="(carrierHistory?.step||60)*1.8" :label="`${c.name} ${chartMode==='loss'?'丢包率':'延迟'}趋势`"/><div class="carrier-footer"><span :title="`有效 ${c.validRounds||0} 轮 / 已上报 ${c.rounds||0} 轮；异常或未上报不算丢包`">覆盖 {{pct(c.coverage)}}</span><span :title="time(c.availableFrom)">{{c.availableFrom && new Date(c.availableFrom)-new Date(carrierHistory?.from)>120000?'历史积累中':''}}</span></div><p v-if="c.error" class="due">{{probeErrors[c.error]}}</p></section></div>
          <div class="section-heading"><h2>资源历史</h2><select v-model="hours" aria-label="历史时间范围"><option :value="1">1 小时</option><option :value="6">6 小时</option><option :value="24">24 小时</option><option :value="168">7 天</option></select></div><p v-if="historyError" role="alert">{{historyError}}<button @click="loadDetails">重试</button></p><div class="history-grid"><section><h3>CPU 使用率</h3><MonitorTrend :points="metricPoints('cpu')" :gap-seconds="history?.step?history.step*2:180" label="CPU 使用率历史" unit="%"/></section><section><h3>下载速率</h3><MonitorTrend :points="metricPoints('net_rx')" :gap-seconds="history?.step?history.step*2:180" label="下载速率历史" unit="B/s"/></section><section><h3>上传速率</h3><MonitorTrend :points="metricPoints('net_tx')" :gap-seconds="history?.step?history.step*2:180" label="上传速率历史" unit="B/s"/></section></div><details class="advanced-info"><summary>硬件与采集信息</summary><p>{{selected.cpuName}} · Agent {{selected.agentVersion}}</p></details>
          <div class="section-heading"><h2>本机服务</h2><span>{{time(selected.servicesAt)}}</span></div><div class="service-links"><span v-for="service in selected.services" :key="service.unit">{{service.unit}} · {{!selected.servicesAt || Date.now()-new Date(selected.servicesAt).getTime()>180000 ? '采样已过期' : serviceStatuses[service.status]||'未知'}}</span><span v-if="!selected.services?.length" class="muted">暂无服务状态</span></div><div class="service-links"><a v-for="link in selected.links" :key="link.url" :href="link.url" target="_blank" rel="noopener noreferrer">{{link.title}} <Icon name="external-link" :size="14"/></a><span v-if="!selected.links.length" class="muted">暂无关联服务</span></div>
        </div>
        <div v-if="tab==='tcp'" class="detail-content"><div class="section-heading"><h2>TCP 探测</h2><select v-model="hours" aria-label="TCP 历史范围"><option :value="1">1 小时</option><option :value="6">6 小时</option><option :value="24">24 小时</option><option :value="168">7 天</option></select></div><p v-if="historyError" class="error">{{historyError}}</p><p v-if="!Object.keys(history?.probes||{}).length" class="empty">暂无探测，可在监控设置中添加。</p><div class="history-grid"><section v-for="(name,id) in history?.probes||{}" :key="id"><h3>{{name}} · 丢包 {{(history.ping||[]).some(p=>String(p.task_id)===String(id))?`${history.loss?.[id]||0}%`:'—'}}</h3><MonitorTrend :label="`${name} TCP 延迟`" :points="(history.ping||[]).filter(p=>String(p.task_id)===String(id)).map(p=>({at:new Date(p.ts*1000).toISOString(),ms:p.latency>=0?p.latency:null}))" :gap-seconds="(history.step||60)*2"/></section></div></div>
        <div v-if="tab==='edit'" class="detail-content">
          <template v-if="preview"><h2>确认这次修改</h2><p class="muted">目标：{{selected.name}} · 预览 15 分钟内有效。仅修改下列资料。</p><div class="diff-row" v-for="(value,key) in preview.patch" :key="key"><strong>{{labels[key]||key}}</strong><del>{{display(key,preview.before?.[key]??preview.before_state?.[key])}}</del><span>→ {{display(key,value)}}</span></div><div class="form-actions"><button :disabled="busy" @click="preview=null">返回</button><button class="primary" :disabled="busy" @click="confirm">{{busy?'正在核对并保存…':'确认修改'}}</button></div></template>
          <template v-else-if="editing"><form class="asset-form" @submit.prevent="propose"><label>供应商<input v-model="form.provider" maxlength="80"/></label><label>分组<input v-model="form.group" maxlength="80"/></label><label>到期日期<input v-model="form.expires_at" type="date"/></label><label>下一账单日期<input v-model="form.billingDate" type="date"/></label><label>周期费用<input v-model="form.price" type="number" min="0" max="1000000" step="any" required/></label><label>币种<input v-model="form.currency" maxlength="3" pattern="[A-Z]{3}" required/></label><label>计费周期<select v-model="form.billing_cycle"><option v-for="(name,key) in cycles" :key="key" :value="key">{{name}}</option><option v-if="!cycles[form.billing_cycle]" :value="form.billing_cycle">{{form.billing_cycle}}</option></select></label><label>续费方式<select v-model="form.renewalMode"><option value="">未录入</option><option value="manual">手动续费</option><option value="auto">供应商自动续费</option><option value="cancel">计划不续费</option></select></label><label class="wide">用途<textarea v-model="form.purpose" maxlength="500" rows="2"/></label><label class="wide">标签（逗号分隔）<input v-model="form.tags"/></label><label class="wide">关联服务（每行：名称 | https://域名/路径）<textarea v-model="form.links" rows="3" placeholder="NAV | https://nav.skrskr.net"/><small>仅保存入口，不自动访问；请勿填写密码或令牌。</small></label><label class="wide check"><input v-model="form.notify" type="checkbox"/>启用服务器提醒</label><div class="form-actions wide"><button type="button" :disabled="busy" @click="editing=false">取消</button><button class="primary" :disabled="busy" type="submit">核对修改</button></div></form></template>
          <template v-else><div class="section-heading"><h2>资产资料</h2><button @click="beginEdit">编辑资料</button></div><dl class="asset-values"><template v-for="(label,key) in labels" :key="key"><dt>{{label}}</dt><dd>{{display(key,selected[key])}}</dd></template></dl><button @click="tab='ai'">从账单截图识别资料</button></template>
        </div>
        <div v-if="tab==='ai'" class="detail-content ai-panel"><h2>AI 识图与诊断</h2><p>当前目标：<strong>{{selected.name}}</strong>。识别结果先填入表单，核对后再保存。</p><label>问题或账单原文<textarea v-model="aiText" maxlength="1500" rows="3" placeholder="分析当前资源和三网状况，或提取这张账单中的资料"/></label><label class="image-input">账单截图（可选）<input type="file" accept="image/png,image/jpeg,image/webp" @change="imageSelected"/></label><div v-if="aiImage" class="image-preview"><img :src="aiImage" alt="待识别的账单截图"/><span>{{aiFileName}}</span><button @click="aiImage='';aiFileName=''">移除截图</button></div><p class="muted">使用已配置的 AI 服务处理所选资料，截图不保存。请遮盖敏感信息。</p><div class="tools"><button :disabled="aiBusy" @click="askAi('diagnose')">{{aiBusy?'分析中…':'分析当前状况'}}</button><button class="primary" :disabled="aiBusy||(!aiImage&&!aiText.trim())" @click="askAi('extract')">识别账单资料</button></div><section v-if="aiResult" class="ai-result" aria-live="polite"><span class="muted">AI 生成 · {{aiResult.model}}</span><p v-if="aiResult.answer" class="answer">{{aiResult.answer}}</p><template v-else><p>识别到的服务器：{{aiResult.identifiedServer}}；填写目标：{{selected.name}}</p><p>{{aiResult.evidence}}</p><p v-for="warning in aiResult.warnings" :key="warning" class="due">{{warning}}</p><dl class="asset-values"><template v-for="(value,key) in aiResult.patch" :key="key"><dt>{{labels[key]}}</dt><dd>{{display(key,value)}}</dd></template></dl><button :disabled="!Object.keys(aiResult.patch).length" @click="useExtraction">填入表单，继续核对</button></template></section></div>
        <div v-if="tab==='history'" class="detail-content"><div class="section-heading"><h2>维护记录</h2><button @click="loadDetails">刷新记录</button></div><p v-if="!changes.length">还没有修改记录。</p><article v-for="change in changes" :key="change.id" class="change"><div><strong>{{changeStatuses[change.status]}}</strong><time>{{time(change.created_at)}}</time></div><p>{{Object.keys(change.patch).map(k=>labels[k]||k).join('、')}}</p><button v-if="change.status==='applied'" :disabled="busy" @click="undo(change)">预览撤销</button><button v-if="['uncertain','applying'].includes(change.status)" :disabled="busy" @click="reconcile(change)">回读核对结果</button><button v-if="change.status==='preview'" :disabled="busy" @click="preview={...change,before:change.before_state};tab='edit'">查看修改</button></article></div>
      </div><p v-else class="empty">{{loading?'正在加载服务器…':'服务器未找到或无权访问。'}}</p>
    </Modal>
  </main>
</template>
<style scoped src="./monitorWorkspace.css"></style>
