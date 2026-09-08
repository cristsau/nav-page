<script setup>
import {onBeforeUnmount,ref} from 'vue'
import Modal from './Modal.vue'
import {apiRequest,registerPasswordReauthHandler} from '@/shared/services/apiClient'
import '@/styles/auth-email.css'

const open=ref(false),password=ref(''),busy=ref(false),error=ref('')
let pending=null
const unregister=registerPasswordReauthHandler(action=>new Promise((resolve,reject)=>{
 if(pending){reject(new Error('请先完成当前身份验证，再重试其他操作。'));return}
 pending={action,resolve,reject};password.value='';error.value='';open.value=true
}))
function cancel() {
 if(busy.value)return
 pending?.reject(new Error('已取消敏感操作，未执行变更。'))
 pending=null;open.value=false;password.value=''
}
async function confirm() {
 if(!pending || busy.value)return
 busy.value=true;error.value=''
 try {
  await apiRequest('/auth/action/reauth',{method:'POST',cache:'no-store',body:JSON.stringify({...pending.action,currentPassword:password.value})})
  const done=pending;pending=null;open.value=false;password.value='';done.resolve()
 } catch(e){error.value=e.status===429?'尝试过于频繁，请稍后再试。':'无法验证当前密码，请检查后重试。';password.value=''}
 finally{busy.value=false}
}
onBeforeUnmount(()=>{unregister();pending?.reject(new Error('身份验证页面已关闭。'));pending=null;password.value=''})
</script>
<template>
 <Modal :show="open" title="确认是你本人" initial-focus-selector="input[type=password]" :close-disabled="busy" @close="cancel">
  <form class="email-auth email-auth__form" @submit.prevent="confirm">
   <p>导出私有数据或更改系统配置需要验证当前密码。验证仅用于本次操作，5 分钟内有效，不会保存你的密码。</p>
   <label>当前密码<input v-model="password" type="password" autocomplete="current-password" required maxlength="2048" /></label>
   <p v-if="error" class="email-auth__error" role="alert">{{error}}</p>
   <button class="email-auth__primary" type="submit" :disabled="busy">{{busy?'验证中…':'验证并继续'}}</button>
   <button type="button" :disabled="busy" @click="cancel">取消操作</button>
  </form>
 </Modal>
</template>
