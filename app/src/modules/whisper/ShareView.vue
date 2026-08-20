<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getShareByCode as getLocalShareByCode } from '@/shared/db/database'
import { fetchBackendShareByCode, shouldUseBackendNotes } from '@/shared/services/notesApi'
import Icon from '@/shared/components/Icon.vue'
import { resolvePublicAppOrigin } from '@/shared/utils/publicAppOrigin'
import CopyableNoteContent from './components/CopyableNoteContent.vue'

const route = useRoute()

const loading = ref(true)
const errorState = ref(null)
const note = ref(null)
const share = ref(null)
const copyStatus = ref('')
const copyStatusType = ref('success')
let copyStatusTimer = null
let loadSequence = 0

const DEFAULT_APP_DESCRIPTION = '轻量化、Notion风格的个人导航页'
const MANAGED_META_NAMES = [
  'referrer',
  'robots',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image'
]
const MANAGED_META_PROPERTIES = [
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
  'og:url',
  'og:image'
]

function setMeta(name, content) {
  let element = document.head.querySelector(`meta[name="${name}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute('name', name)
    document.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

function setMetaProperty(property, content) {
  let element = document.head.querySelector(`meta[property="${property}"]`)
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute('property', property)
    document.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

function setCanonical(url) {
  let element = document.head.querySelector('link[rel="canonical"]')
  if (!element) {
    element = document.createElement('link')
    element.setAttribute('rel', 'canonical')
    document.head.appendChild(element)
  }
  element.setAttribute('href', url)
}

function removeMeta(name) {
  document.head.querySelectorAll(`meta[name="${name}"]`).forEach((element) => element.remove())
}

function removeMetaProperty(property) {
  document.head
    .querySelectorAll(`meta[property="${property}"]`)
    .forEach((element) => element.remove())
}

function removeCanonical() {
  document.head.querySelectorAll('link[rel="canonical"]').forEach((element) => element.remove())
}

function restoreHead() {
  if (typeof document === 'undefined') return

  setMeta('description', DEFAULT_APP_DESCRIPTION)
  for (const name of MANAGED_META_NAMES) {
    removeMeta(name)
  }
  for (const property of MANAGED_META_PROPERTIES) {
    removeMetaProperty(property)
  }
  removeCanonical()
}

function summarizeContent(value, fallback) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return fallback
  return text.length > 154 ? `${text.slice(0, 153)}…` : text
}

function resolveCanonicalUrl() {
  try {
    return new URL(route.path, resolvePublicAppOrigin()).href
  } catch {
    // The server-rendered canonical remains authoritative when a development
    // build has no configured public origin.
  }

  const existingValue = document.head
    .querySelector('link[rel="canonical"]')
    ?.getAttribute('href')

  try {
    const existingUrl = new URL(existingValue)
    return existingUrl.pathname === route.path
      ? existingUrl.href
      : ''
  } catch {
    return ''
  }
}

function applyPublicHead({
  title = '公开分享',
  description = '通过 DOMO NAV 分享的公开内容',
  imageUrl = ''
} = {}) {
  if (typeof document === 'undefined') return

  const pageTitle = `${title} · DOMO NAV`
  const canonicalUrl = resolveCanonicalUrl()
  const resolvedImageUrl = String(imageUrl || '').trim()
    || (canonicalUrl ? new URL('/domo-logo.png', canonicalUrl).href : '')

  document.title = pageTitle
  setMeta('description', description)
  setMeta('referrer', 'no-referrer')
  setMeta('robots', 'noindex, noarchive, nofollow')
  setMetaProperty('og:type', 'article')
  setMetaProperty('og:site_name', 'DOMO NAV')
  setMetaProperty('og:title', pageTitle)
  setMetaProperty('og:description', description)
  setMeta('twitter:card', resolvedImageUrl ? 'summary_large_image' : 'summary')
  setMeta('twitter:title', pageTitle)
  setMeta('twitter:description', description)

  if (canonicalUrl) {
    setCanonical(canonicalUrl)
    setMetaProperty('og:url', canonicalUrl)
  } else {
    removeCanonical()
    removeMetaProperty('og:url')
  }

  if (resolvedImageUrl) {
    setMetaProperty('og:image', resolvedImageUrl)
    setMeta('twitter:image', resolvedImageUrl)
  } else {
    removeMetaProperty('og:image')
    removeMeta('twitter:image')
  }
}

async function getShareByCode(code) {
  return shouldUseBackendNotes()
    ? fetchBackendShareByCode(code)
    : getLocalShareByCode(code)
}

function setUnavailableState(kind = 'not-found') {
  if (kind === 'network') {
    errorState.value = {
      title: '暂时无法打开',
      description: '未能连接分享服务，请检查网络后重试。'
    }
  } else {
    errorState.value = {
      title: '这篇分享不可用',
      description: '链接可能不存在、已经过期，或已被分享者撤销。'
    }
  }

  applyPublicHead({
    title: errorState.value.title,
    description: errorState.value.description
  })
}

async function loadShare() {
  const sequence = ++loadSequence
  loading.value = true
  errorState.value = null
  note.value = null
  share.value = null

  const code = String(route.params.code || '').trim()
  if (!code) {
    setUnavailableState()
    loading.value = false
    return
  }

  try {
    const result = await getShareByCode(code)
    if (sequence !== loadSequence) return

    if (!result?.note) {
      setUnavailableState()
      return
    }

    share.value = result.share || {}
    note.value = result.note
    applyPublicHead({
      title: note.value.title || '公开分享',
      description: summarizeContent(
        note.value.content,
        `阅读《${note.value.title || '公开分享'}》`
      ),
      imageUrl: note.value.attachments?.[0]?.url || ''
    })
  } catch (error) {
    if (sequence !== loadSequence) return
    setUnavailableState(error?.status === 404 || error?.status === 410 ? 'not-found' : 'network')
  } finally {
    if (sequence === loadSequence) {
      loading.value = false
    }
  }
}

function formatDate(value) {
  if (!value) return ''

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    return `${year}年${month}月${day}日`
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function toDateTime(value) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

const publicDate = computed(() => (
  note.value?.entryDate
  || share.value?.date
  || share.value?.createdAt
  || ''
))

const publicDateLabel = computed(() => (
  note.value?.entryDate
    ? '记录于'
    : '发布于'
))

async function handleCopy(payload) {
  const value = String(payload?.value ?? '').trim()
  const label = String(payload?.label || '内容').trim()
  if (!value) return

  window.clearTimeout(copyStatusTimer)

  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error('Clipboard API unavailable')
    }
    await navigator.clipboard.writeText(value)
    copyStatus.value = `已复制${label === '整行' ? '整行内容' : label}`
    copyStatusType.value = 'success'
  } catch {
    copyStatus.value = '复制失败，请手动选择内容'
    copyStatusType.value = 'error'
  }

  copyStatusTimer = window.setTimeout(() => {
    copyStatus.value = ''
  }, 2200)
}

watch(
  () => route.name === 'ShareView' ? route.params.code : null,
  () => {
    if (route.name === 'ShareView') {
      loadShare()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  loadSequence += 1
  window.clearTimeout(copyStatusTimer)
  restoreHead()
})
</script>

<template>
  <main class="share-page">
    <div class="site-mark" aria-label="DOMO NAV">
      <img src="/domo-logo.png" alt="" width="28" height="28">
      <span>DOMO NAV</span>
    </div>

    <section v-if="loading" class="state-panel" role="status" aria-live="polite">
      <Icon class="state-panel__spinner" name="refresh" :size="22" />
      <p>正在打开分享内容</p>
    </section>

    <section v-else-if="errorState" class="state-panel state-panel--error" role="alert">
      <span class="state-panel__icon">
        <Icon name="circle-x" :size="30" />
      </span>
      <h1>{{ errorState.title }}</h1>
      <p>{{ errorState.description }}</p>
      <button type="button" class="retry-button" @click="loadShare">
        <Icon name="refresh" :size="16" />
        重新检查
      </button>
    </section>

    <article v-else-if="note" class="share-article" aria-labelledby="share-title">
      <header class="article-header">
        <h1 id="share-title">{{ note.title }}</h1>
        <div v-if="formatDate(publicDate)" class="article-meta">
          <Icon name="calendar" :size="15" />
          <span>{{ publicDateLabel }}</span>
          <time :datetime="toDateTime(publicDate)">{{ formatDate(publicDate) }}</time>
        </div>
      </header>

      <div class="article-rule" aria-hidden="true"></div>

      <section class="article-body" aria-label="正文">
        <CopyableNoteContent
          v-if="note.content"
          class="article-copyable"
          :content="note.content"
          @copy="handleCopy"
        />
        <p v-else class="article-empty">这篇内容暂时为空。</p>

        <div v-if="note.attachments?.length" class="article-images" aria-label="内容图片">
          <a
            v-for="(image, index) in note.attachments"
            :key="image.url"
            :href="image.url"
            target="_blank"
            rel="noopener noreferrer"
            :aria-label="`打开图片 ${image.name || index + 1}`"
          >
            <img
              :src="image.url"
              :alt="image.name || `内容图片 ${index + 1}`"
              loading="lazy"
              referrerpolicy="no-referrer"
            >
            <span>{{ image.name || `图片 ${index + 1}` }}</span>
          </a>
        </div>

        <div v-if="note.tags?.length" class="article-tags" aria-label="标签">
          <span v-for="tag in note.tags" :key="tag">{{ tag }}</span>
        </div>
      </section>

      <footer class="article-footer">
        <span>CrisTsau</span>
        <span aria-hidden="true">·</span>
        <span>DOMO NAV</span>
      </footer>
    </article>

    <Transition name="copy-status">
      <div
        v-if="copyStatus"
        class="copy-status"
        :class="{ 'is-error': copyStatusType === 'error' }"
        role="status"
        aria-live="polite"
      >
        <Icon :name="copyStatusType === 'error' ? 'alert' : 'circle-check'" :size="15" />
        {{ copyStatus }}
      </div>
    </Transition>
  </main>
</template>

<style scoped>
.share-page {
  --bg-primary: #f7f3ee;
  --bg-secondary: #eee7df;
  --bg-card: #fffdf9;
  --text-primary: #332d29;
  --text-secondary: #6f655e;
  --text-muted: #988b82;
  --border-color: #ded4ca;
  --border-light: #e9e1d9;
  --accent-color: #927052;
  --accent-hover: #76563e;
  --accent-bg: #efe4d8;
  --success-color: #66886e;
  --error-color: #ac6666;
  --shadow-sm: 0 2px 8px rgba(64, 48, 38, 0.08);
  --shadow-md: 0 14px 42px rgba(64, 48, 38, 0.1);
  --shadow-lg: 0 18px 54px rgba(64, 48, 38, 0.16);
  --radius-lg: 24px;
  --radius-full: 9999px;
  --transition-fast: 0.16s ease;

  min-height: 100vh;
  padding: clamp(28px, 6vw, 72px) 22px 56px;
  color-scheme: light;
  color: var(--text-primary);
  background:
    radial-gradient(
      circle at 12% 0%,
      color-mix(in srgb, var(--accent-color) 8%, transparent),
      transparent 32rem
    ),
    var(--bg-primary);
}

.site-mark {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(100%, 760px);
  margin: 0 auto clamp(46px, 8vw, 88px);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.13em;
}

.site-mark img {
  display: block;
  border-radius: 8px;
}

.share-article,
.state-panel {
  width: min(100%, 760px);
  margin-inline: auto;
}

.article-header h1 {
  max-width: 18ch;
  margin: 0;
  color: var(--text-primary);
  font-size: clamp(38px, 7vw, 68px);
  font-weight: 650;
  letter-spacing: -0.045em;
  line-height: 1.08;
  overflow-wrap: anywhere;
  text-wrap: balance;
}

.article-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

.article-meta time {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.article-rule {
  width: 100%;
  height: 1px;
  margin: clamp(30px, 5vw, 48px) 0;
  background: linear-gradient(
    90deg,
    var(--border-color),
    color-mix(in srgb, var(--border-color) 18%, transparent)
  );
}

.article-body {
  min-width: 0;
}

.article-copyable {
  font-size: clamp(16px, 2.2vw, 17px);
  line-height: 1.9;
}

.article-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1.8;
}

.article-images {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 40px;
}

.article-images a {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 18px;
  text-decoration: none;
  transition:
    border-color var(--transition-fast),
    transform var(--transition-fast);
}

.article-images a:hover,
.article-images a:focus-visible {
  border-color: color-mix(in srgb, var(--accent-color) 45%, var(--border-light));
  outline: none;
  transform: translateY(-2px);
}

.article-images img {
  width: 100%;
  aspect-ratio: 4 / 3;
  display: block;
  object-fit: cover;
}

.article-images span {
  display: block;
  padding: 10px 12px 11px;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.article-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 36px;
}

.article-tags span {
  padding: 6px 11px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-full);
  font-size: 12px;
}

.article-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: clamp(52px, 9vw, 92px);
  padding-top: 22px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-light);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.state-panel {
  max-width: 520px;
  padding: clamp(30px, 6vw, 48px);
  text-align: center;
  background: color-mix(in srgb, var(--bg-card) 88%, transparent);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

.state-panel__spinner {
  margin: 0 auto 14px;
  color: var(--accent-color);
  animation: spin 1s linear infinite;
}

.state-panel > p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.7;
}

.state-panel--error h1 {
  margin: 18px 0 10px;
  color: var(--text-primary);
  font-size: clamp(24px, 5vw, 32px);
  letter-spacing: -0.025em;
}

.state-panel__icon {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  margin-inline: auto;
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 10%, transparent);
  border-radius: 50%;
}

.retry-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  margin-top: 24px;
  padding: 10px 18px;
  color: #fff;
  background: var(--accent-color);
  border: 0;
  border-radius: 12px;
  font: inherit;
  font-size: 14px;
  font-weight: 650;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    transform var(--transition-fast);
}

.retry-button:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.retry-button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent-color) 35%, transparent);
  outline-offset: 3px;
}

.copy-status {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100vw - 44px));
  padding: 11px 15px;
  color: #fff;
  background: color-mix(in srgb, var(--success-color) 88%, #111);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  font-size: 13px;
}

.copy-status.is-error {
  background: color-mix(in srgb, var(--error-color) 88%, #111);
}

.copy-status-enter-active,
.copy-status-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.copy-status-enter-from,
.copy-status-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .share-page {
    padding: 24px 18px 40px;
  }

  .site-mark {
    margin-bottom: 48px;
  }

  .article-header h1 {
    font-size: clamp(34px, 12vw, 48px);
  }

  .article-images {
    grid-template-columns: 1fr;
  }

  .copy-status {
    right: 18px;
    bottom: 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .state-panel__spinner {
    animation: none;
  }

  .article-images a,
  .retry-button,
  .copy-status-enter-active,
  .copy-status-leave-active {
    transition: none;
  }
}
</style>
