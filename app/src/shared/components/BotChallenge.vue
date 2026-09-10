<script setup>
import { onMounted,onBeforeUnmount,ref } from 'vue'
import { fetchBotGuardConfig,loadTurnstile } from '@/shared/services/botGuardApi'
const props=defineProps({action:{type:String,required:true}})
const host=ref(null),status=ref('loading'),error=ref('')
let enabled=true,token='',widget=null,api=null,disposed=false,siteKey='',size='',generation=0,resizeObserver=null
function renderWidget() {
  if(disposed || !api || !host.value)return
  const nextSize=host.value.getBoundingClientRect().width>=300?'flexible':'compact'
  if(widget!==null && size===nextSize)return
  // A changed widget cannot reuse proof from its previous size/lifecycle.
  const current=++generation
  token='';status.value='waiting';error.value='';size=nextSize
  if(widget!==null){api.remove(widget);widget=null}
  try {
    widget=api.render(host.value,{sitekey:siteKey,action:props.action,theme:'auto',size,
      'response-field':false,
      callback:value=>{if(disposed || current!==generation)return;token=value;status.value='ready';error.value=''},
      'expired-callback':()=>{if(disposed || current!==generation)return;token='';status.value='waiting'},
      'error-callback':()=>{if(disposed || current!==generation)return;token='';status.value='error';error.value='安全验证暂不可用，请重试。'},
      'timeout-callback':()=>{if(disposed || current!==generation)return;token='';status.value='error';error.value='验证超时，请重试。'}})
  }catch(e){status.value='error';error.value=e.message}
}
async function mountWidget() {
  token='';status.value='loading';error.value=''
  ++generation
  if(widget!==null){api.remove(widget);widget=null}
  try {
    const config=await fetchBotGuardConfig()
    if(disposed)return
    enabled=config.enabled!==false
    if(!enabled){status.value='off';return}
    if(!config.siteKey)throw new Error('安全验证尚未配置完成，请稍后重试。')
    siteKey=config.siteKey
    api=await loadTurnstile()
    if(disposed)return
    renderWidget()
  }catch(e){if(!disposed){status.value='error';error.value=e.message}}
}
function takeToken() {
  if(status.value==='off' && !enabled)return undefined
  if(!token)throw Object.assign(new Error('请先完成安全验证，再提交。'),{code:'BOT_CHALLENGE_REQUIRED'})
  const value=token;token=''
  // A token is one use. A second click must wait for a fresh widget result.
  status.value='waiting';if(api && widget!==null)api.reset(widget)
  return value
}
onMounted(()=>{
  resizeObserver=new ResizeObserver(()=>{if(widget!==null)renderWidget()})
  resizeObserver.observe(host.value)
  mountWidget()
})
onBeforeUnmount(()=>{disposed=true;++generation;token='';resizeObserver?.disconnect();if(api && widget!==null)api.remove(widget)})
defineExpose({takeToken})
</script>
<template>
  <section v-show="status!=='off'" class="bot-challenge" aria-label="安全验证">
    <div ref="host" class="bot-challenge__host" />
    <p v-if="status==='loading'" role="status">正在准备安全验证…</p>
    <p v-if="error" role="alert">{{error}}</p>
    <button v-if="status==='error'" type="button" @click="mountWidget">重新加载验证</button>
    <small>安全验证由 Cloudflare 提供。<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">隐私说明</a></small>
  </section>
</template>
<style scoped>
.bot-challenge{display:grid;justify-items:center;gap:4px;padding:0;color:var(--text-secondary);font-size:12px;min-width:0}
.bot-challenge__host{width:100%;min-width:0;display:flex;justify-content:center}.bot-challenge p{margin:0;text-align:center}.bot-challenge small{font-size:11px;line-height:1.5;text-align:center}.bot-challenge a{display:inline-flex;align-items:center;min-height:44px;color:var(--text-primary);text-decoration:underline}.bot-challenge button{min-height:44px;padding:8px 14px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);color:var(--text-primary);font:inherit;cursor:pointer}
</style>
