<script setup>
import { onMounted,onBeforeUnmount,ref } from 'vue'
import { fetchBotGuardConfig,loadTurnstile } from '@/shared/services/botGuardApi'
const props=defineProps({action:{type:String,required:true}})
const host=ref(null),status=ref('loading'),error=ref('')
let enabled=true,token='',widget=null,api=null,disposed=false
async function mountWidget() {
  status.value='loading';error.value=''
  try {
    const config=await fetchBotGuardConfig()
    if(disposed)return
    enabled=config.enabled
    if(!enabled){status.value='off';return}
    if(!config.siteKey)throw new Error('安全验证尚未配置完成，请稍后重试。')
    api=await loadTurnstile()
    if(disposed)return
    if(widget!==null)api.remove(widget)
    widget=api.render(host.value,{sitekey:config.siteKey,action:props.action,theme:'auto',size:'compact',
      'response-field':false,
      callback:value=>{token=value;status.value='ready';error.value=''},
      'expired-callback':()=>{token='';status.value='waiting'},
      'error-callback':()=>{token='';status.value='error';error.value='安全验证暂不可用，请重试。'},
      'timeout-callback':()=>{token='';status.value='error';error.value='验证超时，请重试。'}})
    if(status.value==='loading')status.value='waiting'
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
onMounted(mountWidget)
onBeforeUnmount(()=>{disposed=true;token='';if(api && widget!==null)api.remove(widget)})
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
.bot-challenge{display:grid;justify-items:center;gap:8px;padding:10px 0;color:var(--text-secondary);font-size:12px;min-width:0}
.bot-challenge__host{max-width:100%}.bot-challenge p{margin:0;text-align:center}.bot-challenge small{font-size:11px;line-height:1.5;text-align:center}.bot-challenge a{color:var(--text-primary);text-decoration:underline}.bot-challenge button{min-height:44px;padding:8px 14px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);color:var(--text-primary);font:inherit;cursor:pointer}
</style>
