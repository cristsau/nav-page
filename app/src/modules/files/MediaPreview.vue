<script setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { contentUrl } from './filesApi'

const props = defineProps({ item: { type: Object, required: true } })
const element = ref(null), phase = ref('loading'), failure = ref(0), attempt = ref(0)
let alive = true, timer
const isImage = computed(() => props.item.kind === 'image')
const pending = computed(() => ['loading', 'buffering', 'slow'].includes(phase.value))
const statusText = computed(() => ({ loading: '正在加载预览', buffering: '正在缓冲', slow: '加载较慢，可以稍候或重新加载' })[phase.value] || '')
const errorText = computed(() => {
  if (isImage.value) return '图片未能加载，请检查网络或重新登录后再试。'
  if (failure.value === 2) return '传输中断，请检查网络后重新加载。'
  if (failure.value === 3) return '浏览器未能解码此文件。可下载原文件，或为视频生成兼容副本。'
  return '文件格式、编码或访问状态暂不支持预览。可重新加载，或使用下方下载入口。'
})
function wait(phaseName = 'loading', event) {
  if (!alive || phase.value === 'error' || (event && event.currentTarget !== element.value)) return
  clearTimeout(timer); phase.value = phaseName
  timer = setTimeout(() => { if (alive && pending.value) phase.value = 'slow' }, 12000)
}
function ready(event) {
  if (!alive || phase.value === 'error' || (event && event.currentTarget !== element.value)) return
  clearTimeout(timer); phase.value = 'ready'
}
function failed(event) {
  if (!alive || event.currentTarget !== element.value) return
  clearTimeout(timer); failure.value = event.target.error?.code || 0; phase.value = 'error'
}
function release() {
  const media = element.value
  if (!media) return
  if (!isImage.value) media.pause()
  media.removeAttribute('src')
  if (!isImage.value) media.load()
}
async function retry() {
  // Replace the element, not the URL or authentication. Never retry a write or autoplay.
  clearTimeout(timer); release(); failure.value = 0; phase.value = 'loading'; attempt.value++
  await nextTick()
  if (alive && phase.value === 'loading') wait()
}
wait()
onBeforeUnmount(() => { alive = false; clearTimeout(timer); release() })
</script>

<template>
  <section class="media-preview" :data-phase="phase" aria-label="文件预览">
    <div class="media-stage" :class="{ 'media-stage-audio': item.kind === 'audio' }" :aria-busy="pending">
      <img v-if="isImage" :key="attempt" ref="element" :src="contentUrl(item.id, true)" :alt="item.name" @load="ready" @error="failed">
      <component :is="item.kind === 'audio' ? 'audio' : 'video'" v-else :key="attempt" ref="element"
        :src="contentUrl(item.id, true)" controls playsinline preload="metadata" :aria-label="item.name"
        @loadedmetadata="ready" @canplay="ready" @playing="ready" @ended="ready"
        @waiting="wait('buffering', $event)" @seeking="wait('buffering', $event)" @seeked="ready" @error="failed" />
      <div v-if="phase === 'error'" class="media-error" role="alert">
        <span class="media-mark"><Icon name="alert" :size="24" /></span>
        <strong>暂时无法预览</strong><p>{{ errorText }}</p>
      </div>
    </div>
    <div class="media-status" aria-live="polite" aria-atomic="true">
      <span v-if="pending"><Icon name="refresh" :size="15" :class="{ 'media-spinner': phase !== 'slow' }" />{{ statusText }}</span>
      <span v-else-if="phase === 'error'">原文件未修改</span>
      <span v-else><Icon :name="isImage ? 'image' : 'play'" :size="15" />{{ isImage ? '图片已加载' : '浏览器原生播放 · 原文件保持不变' }}</span>
      <button v-if="['error', 'slow'].includes(phase)" type="button" @click="retry"><Icon name="refresh" :size="15" />重新加载预览</button>
    </div>
  </section>
</template>

<style scoped>
.media-preview{border:1px solid var(--border-color);border-radius:14px;overflow:hidden;background:var(--bg-secondary)}
.media-stage{position:relative;display:grid;place-items:center;min-height:180px;background:#15171b;isolation:isolate}
.media-stage video{display:block;width:100%;max-height:55vh;aspect-ratio:16/9;object-fit:contain}
.media-stage img{display:block;max-width:100%;max-height:55vh;object-fit:contain}
.media-stage audio{width:calc(100% - 32px);margin:28px 16px}
.media-stage-audio{min-height:110px;background:var(--bg-primary)}
.media-preview[data-phase=error] .media-stage{min-height:220px}
.media-stage>img,.media-stage>video,.media-stage>audio,.media-error{grid-area:1/1}
.media-error{position:relative;z-index:1;box-sizing:border-box;width:100%;align-self:stretch;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;background:var(--bg-secondary);color:var(--text-primary)}
.media-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:var(--bg-primary);color:var(--text-muted)}
.media-error strong{font-size:14px}.media-error p{margin:0;max-width:420px;font-size:12px;line-height:1.7;color:var(--text-secondary)}
.media-status{display:flex;justify-content:space-between;align-items:center;gap:10px;min-height:48px;padding:8px 14px;color:var(--text-secondary);font-size:12px;line-height:1.5}
.media-status>span{display:flex;align-items:center;gap:8px;min-width:0}.media-status svg{flex-shrink:0}
.media-status button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:8px 12px;border:1px solid var(--border-color);border-radius:9px;background:var(--bg-primary);color:var(--text-primary);font:inherit;white-space:nowrap;cursor:pointer}
.media-status button:hover{background:var(--bg-hover)}.media-status button:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}
.media-spinner{animation:media-spin 1s linear infinite}@keyframes media-spin{to{transform:rotate(360deg)}}
@media(max-width:440px){.media-status{flex-wrap:wrap;padding:12px}.media-status button{min-height:44px;width:100%}.media-stage{min-height:210px}.media-stage-audio{min-height:110px}.media-error{padding:18px}.media-error p{font-size:12px}}
@media(prefers-reduced-motion:reduce){.media-spinner{animation:none}}
</style>
