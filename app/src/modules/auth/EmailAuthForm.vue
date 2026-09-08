<script setup>
import {computed,nextTick,onBeforeUnmount,ref} from 'vue'
import {useAuth} from '@/shared/composables/useAuth'
import {authEmailRequest,authEmailError} from '@/shared/services/authEmailApi'
import '@/styles/auth-email.css'

const props=defineProps({mode:{type:String,default:'login'},redirectTarget:{type:String,default:'/'},maskedEmail:{type:String,default:''},resetAvailable:{type:Boolean,default:false}})
const emit=defineEmits(['back','reset','completed'])
const {loginWithEmail,forgetSession}=useAuth()
const email=ref(''),code=ref(''),newPassword=ref(''),confirmPassword=ref('')
const challengeId=ref(''),busy=ref(false),error=ref(''),message=ref(''),complete=ref(false),codeInput=ref(null)
const retryAt=ref(0),expiresAt=ref(0),now=ref(Date.now())
const timer=setInterval(()=>{now.value=Date.now()},1000)
const remaining=computed(()=>Math.max(0,Math.ceil((retryAt.value-now.value)/1000)))
const expired=computed(()=>Boolean(expiresAt.value && now.value>=expiresAt.value))
const isPassword=computed(()=>props.mode!=='login')
const prefix=computed(()=>props.mode==='login'?'/auth/email-login':props.mode==='reset'?'/auth/password-reset':'/auth/account/password/email')
async function send() {
 if(busy.value || remaining.value)return
 busy.value=true;error.value='';message.value=''
 try {
   const result=await authEmailRequest(`${prefix.value}/request`,props.mode==='change'?{}:{email:email.value})
   challengeId.value=result.challengeId;code.value=''
   now.value=Date.now();retryAt.value=now.value+result.resendAfter*1000;expiresAt.value=now.value+result.expiresIn*1000
   message.value=result.message
   await nextTick();codeInput.value?.focus()
 } catch(e){error.value=authEmailError(e)}
 finally{busy.value=false}
}
async function submit() {
 if(!challengeId.value){await send();return}
 if(busy.value)return
 error.value=''
 if(expired.value){error.value='本次验证码已过期，请重新申请。';return}
 if(!/^\d{6}$/.test(code.value)){error.value='请输入完整的 6 位数字验证码。';return}
 if(isPassword.value && (Array.from(newPassword.value).length<15 || Array.from(newPassword.value).length>1024 || newPassword.value!==confirmPassword.value)) {
   error.value='新密码须为 15–1024 个字符，且两次输入一致。';return
 }
 busy.value=true
 try {
   const proof={challengeId:challengeId.value,code:code.value}
   if(props.mode==='login') {
     await loginWithEmail(proof)
     code.value=''
     const url=new URL(props.redirectTarget,window.location.origin)
     window.location.assign(url.origin===window.location.origin && !props.redirectTarget.includes('\\')?`${url.pathname}${url.search}${url.hash}`:'/')
   } else {
     await authEmailRequest(`${prefix.value}/confirm`,{...proof,newPassword:newPassword.value,confirmPassword:confirmPassword.value})
     code.value='';newPassword.value='';confirmPassword.value='';complete.value=true
     forgetSession();emit('completed')
     if(props.mode==='change')window.location.assign('/auth?passwordChanged=1')
   }
 } catch(e){error.value=authEmailError(e)}
 finally{busy.value=false}
}
function changeAddress(){challengeId.value='';code.value='';message.value='';expiresAt.value=0}
onBeforeUnmount(()=>{clearInterval(timer);code.value='';newPassword.value='';confirmPassword.value=''})
</script>

<template>
 <section class="email-auth" :aria-busy="busy">
  <div v-if="complete" class="email-auth__notice" role="status">
   <h3>密码已重设</h3><p>所有设备均已退出。请使用新密码重新登录。</p>
   <button class="email-auth__primary" type="button" @click="emit('back')">返回账号密码登录</button>
  </div>
  <form v-else class="email-auth__form" @submit.prevent="submit">
   <header><h3>{{mode==='login'?'一封邮件，回到你的工作台':mode==='reset'?'找回账号密码':'通过邮箱验证修改密码'}}</h3>
    <p>{{isPassword?'修改成功后，两个域名的全部设备会话和旧恢复码都将失效。':'仅限已审批且已验证绑定的邮箱，不会自动创建账号。'}}</p>
   </header>
   <label v-if="mode!=='change'">绑定邮箱<input v-model="email" type="email" autocomplete="email" inputmode="email" maxlength="320" required :readonly="Boolean(challengeId)" @input="error=''" /></label>
   <p v-else>验证邮件将发送到 {{maskedEmail}}。</p>
   <template v-if="challengeId">
    <label>6 位验证码<input ref="codeInput" v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="email-auth__code" /></label>
    <p v-if="expired" class="email-auth__error">本次验证码已过期，请重新申请。</p>
    <template v-if="isPassword">
     <label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" required maxlength="2048" /></label>
     <label>确认新密码<input v-model="confirmPassword" type="password" autocomplete="new-password" required maxlength="2048" /></label>
     <p>至少 15 个字符，支持空格、粘贴和密码管理器。</p>
    </template>
   </template>
   <p v-if="error" class="email-auth__error" role="alert">{{error}}</p>
   <p v-if="message" class="email-auth__notice" role="status">{{message}}</p>
   <button class="email-auth__primary" type="submit" :disabled="busy || (challengeId && expired) || (!challengeId && remaining>0)">{{busy?'处理中…':!challengeId?(remaining>0?`${remaining} 秒后重新申请`:'获取验证码'):isPassword?'确认修改并退出全部设备':'验证并登录'}}</button>
   <div v-if="challengeId" class="email-auth__actions">
    <button type="button" :disabled="busy || remaining>0" @click="send">{{remaining>0?`${remaining} 秒后重发`:'重新申请验证码'}}</button>
    <button v-if="mode!=='change'" type="button" :disabled="busy" @click="changeAddress">修改邮箱</button>
   </div>
   <button v-if="mode==='reset'" type="button" @click="emit('back')">返回登录</button>
   <button v-else-if="mode==='login' && resetAvailable" type="button" @click="emit('reset')">忘记密码？通过邮箱重设</button>
  </form>
 </section>
</template>
