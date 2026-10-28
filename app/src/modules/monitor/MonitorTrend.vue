<script setup>
import { computed } from 'vue'
const props=defineProps({points:{type:Array,default:()=>[]},label:{type:String,default:'趋势'},valueKey:{type:String,default:'ms'},gapSeconds:{type:Number,default:180},unit:{type:String,default:'ms'},from:[String,Date],to:[String,Date]})
const timeLabel=v=>new Date(v).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
const validValues=computed(()=>props.points.map(p=>p[props.valueKey]).filter(v=>v!==null&&Number.isFinite(v)))
function format(value){if(props.unit==='B/s'){const u=Math.min(3,Math.max(0,Math.floor(Math.log(Math.max(1,value))/Math.log(1024))));return `${(value/1024**u).toFixed(1)} ${['B/s','KB/s','MB/s','GB/s'][u]}`}return `${value.toFixed(1)}${props.unit==='%'?'%':` ${props.unit}`}`}
const plotted=computed(()=>{
  const data=props.points.map(p=>({t:new Date(p.at).getTime(),v:p.addresses?.length>1?null:p[props.valueKey],address:p.addresses?.join(',')})).filter(p=>Number.isFinite(p.t)).sort((a,b)=>a.t-b.t)
  const valid=data.filter(p=>p.v!==null&&Number.isFinite(p.v));if(!valid.length)return []
  const lo=props.from?+new Date(props.from):data[0].t,span=Math.max(1,(props.to?+new Date(props.to):data.at(-1).t)-lo),max=props.unit==='%'?100:Math.max(1,...valid.map(p=>p.v));let lines=[],line=[],previous
  for(const p of data){
    if(p.v===null||!Number.isFinite(p.v)||(previous&&(p.t-previous.t>props.gapSeconds*1000||p.address!==previous.address))){if(line.length)lines.push(line.join(' '));line=[]}
    if(p.v!==null&&Number.isFinite(p.v))line.push(`${4+Math.max(0,Math.min(1,(p.t-lo)/span))*292},${56-(p.v/max)*50}`)
    previous=p
  }
  if(line.length)lines.push(line.join(' '));return lines
})
</script>
<template><div class="trend-wrap"><div class="trend"><svg v-if="plotted.length" viewBox="0 0 300 64" role="img" :aria-label="label" preserveAspectRatio="none"><title>{{label}}</title><path d="M0 57H300" stroke="currentColor" opacity=".15"/><polyline v-for="(line,i) in plotted" :key="i" :points="line" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/></svg><span v-else>暂无有效采样</span></div><div v-if="from&&to" class="range time-axis"><time>{{timeLabel(from)}}</time><time>{{timeLabel(to)}}</time></div><div v-if="validValues.length" class="range"><span>最低 {{format(Math.min(...validValues))}}</span><span>最高 {{format(Math.max(...validValues))}}</span></div></div></template>
<style scoped>.trend-wrap{min-width:0}.trend{height:64px;display:flex;align-items:center;color:var(--accent-color)}svg{width:100%;height:100%;overflow:visible}.trend span{font-size:12px;color:var(--text-secondary)}.range{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--text-secondary);font-variant-numeric:tabular-nums}</style>
