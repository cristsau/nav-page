<script setup>
import {onMounted,onBeforeUnmount,ref,computed} from 'vue'
import {authEmailRequest,authEmailError} from '@/shared/services/authEmailApi'
import {useAuth} from '@/shared/composables/useAuth'
import EmailAuthForm from '@/modules/auth/EmailAuthForm.vue'
import '@/styles/auth-email.css'

const emit=defineEmits(['updated'])
const {refreshAll}=useAuth()
const state=ref(null),error=ref(''),message=ref(''),busy=ref(false),phase=ref(''),password=ref(''),email=ref(''),code=ref('')
const challengeId=ref(''),passwordMode=ref(false),retryAt=ref(0),now=ref(Date.now())
const remaining=computed(()=>Math.max(0,Math.ceil((retryAt.value-now.value)/1000)))
const timer=setInterval(()=>{now.value=Date.now()},1000)
async function load() {
 try{state.value=await authEmailRequest('/auth/account/email',{},'GET')}
 catch(e){error.value=authEmailError(e)}
}
function reset() {phase.value='';password.value='';code.value='';challengeId.value='';error.value='';message.value=''}
function begin(){reset();phase.value='password';passwordMode.value=false}
function setChallenge(result,nextPhase) {
 challengeId.value=result.challengeId;retryAt.value=Date.now()+result.resendAfter*1000;phase.value=nextPhase;code.value='';message.value=result.message
}
async function sendNew() {
 const payload={email:email.value}
 if(phase.value==='old'){payload.challengeId=challengeId.value;payload.code=code.value}
 setChallenge(await authEmailRequest('/auth/account/email-bind/request',payload),'new')
}
async function submit() {
 if(busy.value)return
 busy.value=true;error.value='';message.value=''
 try {
  if(phase.value==='password') {
   await authEmailRequest('/auth/account/reauth/password',{currentPassword:password.value});password.value=''
   if(state.value.verified)setChallenge(await authEmailRequest('/auth/account/email-change/request',{}),'old')
   else await sendNew()
  } else if(phase.value==='old')await sendNew()
  else if(phase.value==='new') {
   await authEmailRequest('/auth/account/email-bind/confirm',{challengeId:challengeId.value,code:code.value})
   reset();message.value='邮箱已验证并绑定，其他设备和旧恢复码已失效。请重新生成并妥善保存恢复码。'
   await load();emit('updated');void refreshAll().catch(()=>{})
  }
 } catch(e){error.value=authEmailError(e);password.value=''}
 finally{busy.value=false}
}
async function resend() {
 if(busy.value || remaining.value)return
 busy.value=true;error.value=''
 try {
  if(phase.value==='old')setChallenge(await authEmailRequest('/auth/account/email-change/request',{}),'old')
  else if(phase.value==='new')await sendNew()
 } catch(e){error.value=authEmailError(e)}
 finally{busy.value=false}
}
onMounted(load)
onBeforeUnmount(()=>{clearInterval(timer);password.value='';code.value=''})
</script>
<template>
 <section class="email-auth email-auth__section" :aria-busy="busy" aria-label="邮箱登录与恢复">
  <header><div><h3>邮箱登录与恢复</h3><p>用已验证邮箱登录、找回密码。更换邮箱需要当前密码及新旧邮箱的验证。</p></div>
   <span class="email-auth__status">{{!state?'读取中':state.verified?'已验证':'尚未验证'}}</span></header>
  <p v-if="state">{{state.maskedEmail || '尚未绑定邮箱'}}</p>
  <p v-if="state && !state.emailBinding" class="email-auth__notice">邮箱验证码暂不可用，账号密码和恢复码仍可使用。</p>
  <p v-if="error" class="email-auth__error" role="alert">{{error}}</p>
  <p v-if="message" class="email-auth__notice" role="status">{{message}}</p>
  <div v-if="state && !phase" class="email-auth__actions">
   <button type="button" :disabled="!state.emailBinding" @click="begin">{{state.verified?'更换邮箱':'绑定并验证邮箱'}}</button>
   <button v-if="state.verified && state.emailPasswordReset" type="button" @click="passwordMode=!passwordMode">{{passwordMode?'收起邮箱改密':'通过邮箱验证码改密'}}</button>
  </div>
  <form v-if="phase" class="email-auth__form" @submit.prevent="submit">
   <template v-if="phase==='password'">
    <label>新邮箱<input v-model="email" type="email" autocomplete="email" maxlength="320" required /></label>
    <label>当前密码<input v-model="password" type="password" autocomplete="current-password" required /></label>
    <p>密码复验只授权本次邮箱变更，5 分钟后失效。</p>
   </template>
   <template v-else>
    <p>{{phase==='old'?`先验证原邮箱 ${state.maskedEmail}`:`验证新邮箱 ${email}`}}</p>
    <label>6 位验证码<input v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="email-auth__code" /></label>
   </template>
   <button class="email-auth__primary" type="submit" :disabled="busy">{{busy?'处理中…':phase==='password'?'验证身份并继续':phase==='old'?'验证原邮箱并发送新邮箱验证码':'确认绑定新邮箱'}}</button>
   <div class="email-auth__actions">
    <button v-if="phase!=='password'" type="button" :disabled="busy || remaining>0" @click="resend">{{remaining?`${remaining} 秒后重发`:'重新申请验证码'}}</button>
    <button type="button" :disabled="busy" @click="begin">重新验证身份</button>
    <button type="button" :disabled="busy" @click="reset">取消</button>
   </div>
  </form>
  <EmailAuthForm v-if="passwordMode && !phase" mode="change" :masked-email="state.maskedEmail" />
 </section>
</template>
