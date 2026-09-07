<script setup>
import {onMounted,ref} from 'vue'
import {apiRequest} from '@/shared/services/apiClient'
import '@/styles/auth-email.css'
const state=ref(null),busy=ref(false),error=ref('')
const labels={pending:'等待发送',sending:'发送中',accepted:'SMTP 已接受',failed:'发送失败',unknown:'结果不明',cancelled:'已取消'}
async function refresh() {
 if(busy.value)return
 busy.value=true;error.value=''
 try {state.value=await apiRequest('/admin/auth-email/status',{cache:'no-store'})}
 catch {error.value='暂时无法读取认证邮件状态，请稍后重试。'}
 finally {busy.value=false}
}
onMounted(refresh)
</script>
<template>
 <section class="email-auth email-auth__section" :aria-busy="busy" aria-label="认证邮件运行状态">
  <header><div><h3>认证邮件</h3><p>只显示运行计数，不显示邮箱、验证码或密钥。</p></div><button type="button" :disabled="busy" @click="refresh">{{busy?'读取中…':'刷新状态'}}</button></header>
  <p v-if="error" class="email-auth__error" role="alert">{{error}}</p>
  <template v-if="state">
   <p>验证码登录：{{state.capabilities.emailLogin?'可用':'关闭或未就绪'}} · 邮箱改密：{{state.capabilities.emailPasswordReset?'可用':'关闭或未就绪'}}</p>
   <p>活跃账号中已验证邮箱：{{state.coverage.verified}} / {{state.coverage.active}}</p>
   <dl class="auth-mail-metrics"><div v-for="(label,key) in labels" :key="key"><dt>{{label}}</dt><dd>{{state.queue[key] || 0}}</dd></div></dl>
   <p>最老等待任务：{{state.oldestPendingSeconds}} 秒。近 24 小时验证码消费：{{state.challenges.consumed}}；错误码尝试：{{state.challenges.failed_attempts}}。</p>
   <p class="email-auth__notice">SMTP 接受不代表已到收件箱。结果不明的任务不会自动重发；用户可在冷却结束后重新申请。这里的保留期内计数不能替代真实收件与上线观察验收。</p>
  </template>
 </section>
</template>
<style scoped>
.auth-mail-metrics {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}
.auth-mail-metrics>div {padding:14px;border:1px solid var(--border-color);border-radius:12px}
.auth-mail-metrics dt {font-size:13px;overflow-wrap:anywhere}
.auth-mail-metrics dd {font-size:24px;font-variant-numeric:tabular-nums;margin:10px 0 0}
@media(max-width:480px){.auth-mail-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
