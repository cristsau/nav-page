<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
const route = useRoute()
const failed = route.query.result === 'failed'
const closeHelp = ref(false)
function returnToApp() {
  window.close()
  closeHelp.value = true
}
</script>

<template>
  <main class="oauth-return-page">
    <section class="oauth-return-card" aria-labelledby="oauth-return-title">
      <span class="oauth-return-icon"><Icon :name="failed ? 'alert' : 'circle-check'" :size="32" /></span>
      <p class="oauth-return-eyebrow">DOMO NAV</p>
      <h1 id="oauth-return-title">{{ failed ? '验证尚未完成' : '验证已完成' }}</h1>
      <p>{{ failed ? '请关闭这个窗口，回到原应用重新尝试，或选择其他登录方式。' : '回到刚才的 DOMO NAV，应用会安全接续本次登录。' }}</p>
      <button type="button" @click="returnToApp">返回 DOMO NAV <Icon name="chevron-right" :size="18" /></button>
      <p class="oauth-return-hint" :role="closeHelp ? 'status' : undefined">如果窗口没有自动关闭，请点左上角的“×”，或从主屏幕打开 DOMO NAV。</p>
    </section>
  </main>
</template>

<style scoped>
.oauth-return-page{min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg-primary)}
.oauth-return-card{width:min(100%,420px);padding:40px 28px;text-align:center;background:var(--bg-card);border-radius:28px;color:var(--text-primary);box-shadow:0 12px 48px #00000008}
.oauth-return-icon{display:inline-grid;place-items:center;width:68px;height:68px;border-radius:22px;background:var(--accent-bg);color:var(--accent-color)}
.oauth-return-eyebrow{font-size:12px;letter-spacing:.16em;margin:24px 0 12px;font-weight:650;opacity:.65}
h1{font-size:28px;letter-spacing:-.04em;margin:0 0 12px}p{font-size:16px;line-height:1.65}
button{display:flex;justify-content:center;align-items:center;gap:10px;width:100%;min-height:50px;margin:28px 0 16px;border:0;border-radius:15px;background:var(--accent-color);color:var(--button-primary-text,#fff);font:inherit;font-weight:600;cursor:pointer}
.oauth-return-hint{font-size:13px;opacity:.7}button:focus-visible{outline:3px solid currentColor;outline-offset:4px}
button{background:var(--text-primary);color:var(--bg-card)}
</style>
