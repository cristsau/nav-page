<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { apiRequest } from '@/shared/services/apiClient'

const state = ref('loading'), error = ref(''), frame = ref(null), section = ref('overview'), source = ref('')
let timer, controller, disposed = false
function stop() { clearTimeout(timer); controller?.abort(); source.value = '' }
async function open(next = section.value) {
  stop(); section.value = next; state.value = 'loading'; error.value = ''
  const current = new AbortController(); controller = current
  timer = setTimeout(() => { current.abort(); source.value = ''; state.value = 'error'; error.value = '加载监控超时，请重试。' }, 15000)
  try {
    const status = await apiRequest('/monitor/status', { signal: current.signal })
    if (disposed || current.signal.aborted || controller !== current) return
    if (!status.enabled || !status.connected || status.path !== '/monitor-app/') throw new Error('监控服务尚未接入。')
    source.value = next === 'admin' ? '/monitor-app/admin/nodes' : '/monitor-app/'
  } catch (e) {
    if (disposed || current.signal.aborted || controller !== current) return
    clearTimeout(timer); state.value = 'error'; error.value = e.message || '监控暂不可用，请重试。'
  }
}
function receive(event) {
  if (!source.value || event.origin !== location.origin || event.source !== frame.value?.contentWindow) return
  if (event.data?.type === 'nav-monitor:ready') {
    clearTimeout(timer); state.value = 'ready'
    if (['overview', 'admin'].includes(event.data.section)) section.value = event.data.section
  }
  if (event.data?.type === 'nav-monitor:auth-required') {
    stop(); state.value = 'error'; error.value = '监控访问权限已失效，请确认 NAV 登录状态后重试。'
  }
}
onMounted(() => { window.addEventListener('message', receive); open() })
onBeforeUnmount(() => { disposed = true; stop(); window.removeEventListener('message', receive) })
</script>

<template>
  <main class="monitor-page">
    <header class="monitor-header">
      <div><h1>服务器监控</h1><p>服务器状态、历史指标与管理</p></div>
      <div class="monitor-tools" role="group" aria-label="监控视图">
        <button :aria-pressed="section === 'overview'" @click="open('overview')">总览</button>
        <button :aria-pressed="section === 'admin'" @click="open('admin')">管理</button>
        <button aria-label="重新加载监控" @click="open()"><Icon name="refresh" :size="18" /></button>
      </div>
    </header>
    <section class="monitor-content" :aria-busy="state === 'loading'">
      <div v-if="state !== 'ready'" class="monitor-message" :role="state === 'error' ? 'alert' : 'status'">
        <Icon :name="state === 'error' ? 'alert' : 'server'" :size="28" />
        <h2>{{ state === 'error' ? '暂时无法打开监控' : '正在连接监控' }}</h2>
        <p>{{ state === 'error' ? error : '使用当前 NAV 管理员身份，首次打开需要稍等片刻。' }}</p>
        <button v-if="state === 'error'" @click="open()">重试</button>
      </div>
      <iframe v-if="source" ref="frame" :src="source" title="服务器监控工作台"
        class="monitor-frame" :class="{ 'is-loading': state !== 'ready' }" :inert="state !== 'ready' || undefined"
        referrerpolicy="no-referrer" allow="clipboard-write" />
    </section>
    <p class="monitor-footnote">数据约每 5 秒更新；离开此页面后停止刷新。</p>
  </main>
</template>

<style scoped>
.monitor-page{padding:24px;min-width:0;color:var(--text-primary)}
.monitor-header{display:flex;gap:16px;justify-content:space-between;align-items:center;margin-bottom:16px}
h1{font-size:24px;font-weight:650;margin:0 0 6px}.monitor-header p,.monitor-footnote{color:var(--text-secondary);font-size:13px;margin:0}
.monitor-tools{display:flex;gap:6px}.monitor-tools button,.monitor-message button{min-height:44px;padding:8px 14px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card);color:var(--text-primary);cursor:pointer}
button[aria-pressed=true]{background:var(--accent-bg);border-color:var(--accent-color);color:var(--accent-text)}
button:focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}
.monitor-content{position:relative;min-height:480px;height:calc(100dvh - 152px);border:1px solid var(--border-color);border-radius:10px;overflow:hidden;background:var(--bg-card)}
.monitor-frame{display:block;width:100%;height:100%;border:0}.monitor-frame.is-loading{visibility:hidden}
.monitor-message{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center}
.monitor-message h2{margin:0;font-size:17px}.monitor-message p{max-width:440px;line-height:1.65;color:var(--text-secondary);margin:0}
.monitor-footnote{margin-top:10px}
@media(max-width:820px){.monitor-page{padding:12px}.monitor-header{flex-wrap:wrap;gap:12px}h1{font-size:22px}.monitor-content{height:calc(100dvh - var(--app-shell-header-height,0px) - 260px);min-height:360px}.monitor-tools{margin-left:auto}}
</style>
