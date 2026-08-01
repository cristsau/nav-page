<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import {
  deleteMediaImage,
  fetchMediaImages,
  reconcileMediaLibrary,
  retryMediaDelete,
  updateMediaRetention
} from '@/shared/services/mediaApi'
import {
  formatMediaBytes,
  formatMediaDimensions,
  MEDIA_FILTERS,
  mediaCanDelete,
  mediaCanShare,
  mediaDeletionMessage,
  mediaMarkdown,
  mediaNeedsRetention,
  mediaStatus,
  mediaStatusLabel,
  upsertMediaImage
} from './mediaLibrary'

const PAGE_SIZE = 24

const router = useRouter()
const images = ref([])
const counts = ref(null)
const activeFilter = ref('all')
const query = ref('')
const appliedQuery = ref('')
const nextCursor = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const syncing = ref(false)
const loadError = ref('')
const statusMessage = ref('')
const selectedImage = ref(null)
const previewRef = ref(null)
const deleteConfirming = ref(false)
const retentionConfirming = ref(false)
const busyImageId = ref('')
const loadMoreSentinel = ref(null)
let observer = null
let restoreFocusElement = null
let statusTimer = null

const hasMore = computed(() => Boolean(nextCursor.value))
const selectedStatus = computed(() => selectedImage.value ? mediaStatus(selectedImage.value) : '')

function imageCount(filter) {
  const value = counts.value?.[filter]
  return Number.isFinite(Number(value)) ? Number(value) : null
}

function announce(message) {
  statusMessage.value = message
  if (statusTimer) window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    statusMessage.value = ''
  }, 3200)
}

async function loadImages({ append = false } = {}) {
  if (loading.value || loadingMore.value) return
  if (append && !nextCursor.value) return

  if (append) loadingMore.value = true
  else loading.value = true
  loadError.value = ''

  try {
    const result = await fetchMediaImages({
      filter: activeFilter.value,
      query: appliedQuery.value,
      cursor: append ? nextCursor.value : '',
      limit: PAGE_SIZE
    })
    images.value = append ? [...images.value, ...result.images] : result.images
    nextCursor.value = result.nextCursor
    if (result.counts) counts.value = result.counts
  } catch (error) {
    loadError.value = error.message || '图片加载失败，请稍后重试'
    if (!append) images.value = []
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function chooseFilter(filter) {
  if (filter === activeFilter.value || loading.value || loadingMore.value) return
  activeFilter.value = filter
  nextCursor.value = ''
  await loadImages()
}

async function applySearch() {
  if (loading.value || loadingMore.value) return
  appliedQuery.value = query.value.trim()
  nextCursor.value = ''
  await loadImages()
}

async function syncWithImgBed() {
  if (syncing.value || loading.value || loadingMore.value) return
  syncing.value = true
  try {
    const result = await reconcileMediaLibrary()
    nextCursor.value = ''
    await loadImages()
    if (result.complete === false) {
      announce(`已同步前 ${Number(result.found || 0)} 张图片；数量超过安全上限，本次未判定缺失图片`)
    } else {
      announce(`图床同步完成：发现 ${Number(result.found || 0)} 张，新增 ${Number(result.created || 0)} 张，缺失 ${Number(result.missing || 0)} 张`)
    }
  } catch (error) {
    announce(`图床同步失败：${error.message || '请稍后重试'}`)
  } finally {
    syncing.value = false
  }
}

function openPreview(image, trigger = document.activeElement) {
  restoreFocusElement = trigger instanceof HTMLElement ? trigger : null
  selectedImage.value = image
  deleteConfirming.value = false
  retentionConfirming.value = false
  document.body.style.overflow = 'hidden'
  nextTick(() => previewRef.value?.focus())
}

async function closePreview() {
  if (busyImageId.value) return
  const focusTarget = restoreFocusElement
  selectedImage.value = null
  deleteConfirming.value = false
  retentionConfirming.value = false
  restoreFocusElement = null
  document.body.style.overflow = ''
  await nextTick()
  if (focusTarget?.isConnected) focusTarget.focus()
}

function updateImage(incoming) {
  if (!incoming?.id) return
  images.value = upsertMediaImage(images.value, incoming)
  if (String(selectedImage.value?.id) === String(incoming.id)) {
    selectedImage.value = { ...selectedImage.value, ...incoming }
  }
}

async function setRetention(image, retention) {
  if (!image?.id || busyImageId.value) return null
  busyImageId.value = image.id
  try {
    const updated = await updateMediaRetention(image.id, retention)
    if (updated && (updated.state === 'deleted' || updated.status === 'deleted')) {
      images.value = images.value.filter((item) => String(item.id) !== String(image.id))
      if (String(selectedImage.value?.id) === String(image.id)) {
        selectedImage.value = null
        restoreFocusElement = null
        document.body.style.overflow = ''
      }
      announce(`已切换为自动清理；${mediaDeletionMessage(updated)}`)
      return updated
    }
    updateImage(updated || { ...image, retention })
    announce(retention === 'keep' ? '已设为长期保留' : '已设为自动清理')
    return updated || { ...image, retention }
  } catch (error) {
    announce(`保留策略更新失败：${error.message || '请稍后重试'}`)
    return null
  } finally {
    busyImageId.value = ''
  }
}

function requestRetention(image, retention) {
  if (retention === 'auto' && !mediaNeedsRetention(image)) {
    const referenceCount = Number(image.referenceCount || image.references?.length || 0)
    if (referenceCount === 0) {
      retentionConfirming.value = true
      return
    }
  }
  retentionConfirming.value = false
  void setRetention(image, retention)
}

async function ensureKeptForSharing(image) {
  if (!mediaNeedsRetention(image)) return image
  const updated = await setRetention(image, 'keep')
  if (!updated) throw new Error('无法设为长期保留')
  return updated
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text)
    announce(successMessage)
  } catch {
    announce('复制失败，请在原图页面手动复制地址')
  }
}

async function copyPublicLink(image) {
  try {
    const kept = await ensureKeptForSharing(image)
    await copyText(kept.url, '已设为长期保留并复制公开链接')
  } catch (error) {
    announce(`复制前无法保留图片：${error.message || '请稍后重试'}`)
  }
}

async function copyMarkdown(image) {
  try {
    const kept = await ensureKeptForSharing(image)
    await copyText(mediaMarkdown(kept), '已设为长期保留并复制 Markdown')
  } catch (error) {
    announce(`复制前无法保留图片：${error.message || '请稍后重试'}`)
  }
}

async function shareImage(image) {
  let kept = null
  try {
    kept = await ensureKeptForSharing(image)
    if (navigator.share) {
      await navigator.share({ title: kept.name || '图片', url: kept.url })
      announce('已设为长期保留并打开系统分享')
    } else {
      await copyText(kept.url, '此设备不支持系统分享，已复制长期有效链接')
    }
  } catch (error) {
    if (error?.name === 'NotAllowedError' && kept?.url) {
      await copyText(kept.url, '系统分享不可用，已复制长期有效链接')
    } else if (error?.name !== 'AbortError') {
      announce(`分享失败：${error.message || '请稍后重试'}`)
    }
  }
}

async function performDelete(image) {
  if (!image?.id || !mediaCanDelete(image) || busyImageId.value) return
  busyImageId.value = image.id
  try {
    const updated = await deleteMediaImage(image.id)
    images.value = images.value.filter((item) => String(item.id) !== String(image.id))
    if (String(selectedImage.value?.id) === String(image.id)) {
      selectedImage.value = null
      deleteConfirming.value = false
      retentionConfirming.value = false
      restoreFocusElement = null
      document.body.style.overflow = ''
    }
    announce(mediaDeletionMessage(updated || {}))
  } catch (error) {
    deleteConfirming.value = false
    announce(
      error.status === 409
        ? '图片刚刚被笔记重新引用，原图未删除；引用列表已刷新'
        : `删除失败：${error.message || '已保留原图，可稍后重试'}`
    )
    await loadImages().catch(() => {})
  } finally {
    busyImageId.value = ''
  }
}

async function retryDelete(image) {
  if (!image?.id || busyImageId.value) return
  busyImageId.value = image.id
  try {
    const updated = await retryMediaDelete(image.id)
    if (updated && updated.state !== 'deleted' && updated.status !== 'deleted') {
      updateImage(updated)
      announce('已重新提交清理，请稍后刷新状态')
    } else {
      images.value = images.value.filter((item) => String(item.id) !== String(image.id))
      if (String(selectedImage.value?.id) === String(image.id)) {
        selectedImage.value = null
        restoreFocusElement = null
        document.body.style.overflow = ''
      }
      announce(mediaDeletionMessage(updated || {}))
    }
  } catch (error) {
    announce(`重试失败：${error.message || '请稍后再试'}`)
  } finally {
    busyImageId.value = ''
  }
}

function openReference(reference) {
  const noteId = reference.noteId || reference.id
  closePreview()
  router.push({ path: '/whisper', query: noteId ? { note: String(noteId) } : {} })
}

function handlePreviewKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [...(previewRef.value?.querySelectorAll(
    'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
  ) || [])]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!focusable.includes(document.activeElement)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  await loadImages()
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadImages({ append: true })
  }, { rootMargin: '320px 0px' })
  if (loadMoreSentinel.value) observer.observe(loadMoreSentinel.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  document.body.style.overflow = ''
  if (statusTimer) window.clearTimeout(statusTimer)
})
</script>

<template>
  <div class="media-page">
    <header class="media-header">
      <div class="media-header__left">
        <button class="icon-button" type="button" aria-label="返回导航页" @click="router.push('/')">
          <Icon name="arrow-left" :size="20" />
        </button>
        <div>
          <p>DOMO NAV</p>
          <h1>图片库</h1>
        </div>
      </div>
      <nav class="media-header__nav" aria-label="主要页面">
        <button type="button" aria-label="打开导航首页" @click="router.push('/')"><Icon name="compass" :size="17" /><span>导航</span></button>
        <button type="button" aria-label="打开时光" @click="router.push('/whisper')"><Icon name="note" :size="17" /><span>时光</span></button>
      </nav>
    </header>

    <main class="media-main">
      <section class="media-hero" aria-labelledby="media-title">
        <div>
          <p class="media-hero__eyebrow">一处管理笔记图片</p>
          <h2 id="media-title">看见每张图片的去向</h2>
          <p>图片仍存储在 pic.skrskr.net；NAV 负责展示引用关系、保留策略和安全清理。</p>
        </div>
        <div class="media-hero__legend" aria-label="保留策略说明">
          <span><Icon name="refresh" :size="15" />自动：最后引用移除后可清理</span>
          <span><Icon name="pin" :size="15" />保留：分享链接长期有效</span>
          <button type="button" :disabled="syncing || loading || loadingMore" @click="syncWithImgBed"><Icon name="refresh" :size="15" />{{ syncing ? '同步中' : '同步图床' }}</button>
        </div>
      </section>

      <form class="media-toolbar" role="search" @submit.prevent="applySearch">
        <label class="media-search">
          <Icon name="search" :size="18" />
          <input v-model="query" type="search" placeholder="搜索文件名或笔记标题" aria-label="搜索图片">
        </label>
        <button class="toolbar-search-button" type="submit" :disabled="loading || loadingMore">搜索</button>
        <div class="media-filters" role="group" aria-label="图片状态筛选">
          <button
            v-for="filter in MEDIA_FILTERS"
            :key="filter.id"
            type="button"
            :class="{ 'is-active': activeFilter === filter.id }"
            :aria-pressed="activeFilter === filter.id"
            :disabled="loading || loadingMore"
            @click="chooseFilter(filter.id)"
          >
            {{ filter.label }}
            <span v-if="imageCount(filter.id) !== null">{{ imageCount(filter.id) }}</span>
          </button>
        </div>
      </form>

      <div v-if="loading" class="media-state" role="status">
        <span class="media-spinner" aria-hidden="true"></span>
        <strong>正在整理图片库</strong>
        <p>引用关系和图床状态正在同步。</p>
      </div>

      <div v-else-if="loadError && !images.length" class="media-state media-state--error" role="alert">
        <Icon name="alert" :size="25" />
        <strong>图片库暂时无法打开</strong>
        <p>{{ loadError }}</p>
        <button type="button" @click="loadImages()"><Icon name="refresh" :size="16" />重试</button>
      </div>

      <div v-else-if="!images.length" class="media-state">
        <Icon name="image" :size="28" />
        <strong>这里还没有匹配的图片</strong>
        <p>在笔记或备忘录中上传图片后，会自动出现在这里。</p>
        <button type="button" @click="router.push('/whisper')"><Icon name="note" :size="16" />前往时光</button>
      </div>

      <section v-else class="media-waterfall" aria-label="图片列表">
        <article
          v-for="image in images"
          :key="image.id"
          class="media-card"
          :class="`is-${mediaStatus(image)}`"
        >
          <button class="media-card__preview" type="button" :aria-label="`预览 ${image.name || '图片'}`" @click="openPreview(image, $event.currentTarget)">
            <span v-if="mediaStatus(image) === 'missing'" class="media-card__missing" aria-hidden="true"><Icon name="image" :size="26" /></span>
            <img v-else :src="image.thumbnailUrl || image.url" :alt="image.name || '图片'" loading="lazy" decoding="async">
          </button>
          <div class="media-card__overlay-actions">
            <button type="button" title="复制公开链接" aria-label="复制公开链接并设为长期保留" :disabled="busyImageId === image.id || !mediaCanShare(image)" @click="copyPublicLink(image)"><Icon name="link" :size="16" /></button>
            <button type="button" title="更多操作" :aria-label="`打开 ${image.name || '图片'} 的操作`" @click="openPreview(image, $event.currentTarget)"><Icon name="more-horizontal" :size="17" /></button>
          </div>
          <div class="media-card__body">
            <div class="media-card__status-row">
              <span class="media-status"><i></i>{{ mediaStatusLabel(image) }}</span>
              <span class="media-retention"><Icon :name="mediaNeedsRetention(image) ? 'refresh' : 'pin'" :size="13" />{{ mediaNeedsRetention(image) ? '自动' : '保留' }}</span>
            </div>
            <h3 :title="image.name">{{ image.name || '未命名图片' }}</h3>
            <p>{{ formatMediaDimensions(image) }} · {{ formatMediaBytes(image.size) }}</p>
            <small>{{ Number(image.referenceCount || image.references?.length || 0) }} 处笔记引用</small>
          </div>
        </article>
      </section>

      <div ref="loadMoreSentinel" class="media-sentinel" aria-hidden="true"></div>
      <div v-if="loadingMore" class="media-loading-more" role="status"><span class="media-spinner" aria-hidden="true"></span>加载更多</div>
      <button v-else-if="hasMore" class="media-load-more" type="button" @click="loadImages({ append: true })">加载更多图片</button>
      <p v-if="loadError && images.length" class="media-inline-error" role="alert">{{ loadError }}</p>
    </main>

    <Teleport to="body">
      <Transition name="media-preview">
        <div v-if="selectedImage" class="media-preview" role="presentation" @pointerdown.self="closePreview">
          <section
            ref="previewRef"
            class="media-preview__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-preview-title"
            tabindex="-1"
            @keydown="handlePreviewKeydown"
          >
            <header>
              <div>
                <p>图片详情</p>
                <h2 id="media-preview-title">{{ selectedImage.name || '未命名图片' }}</h2>
              </div>
              <button type="button" aria-label="关闭图片预览" :disabled="Boolean(busyImageId)" @click="closePreview"><Icon name="close" :size="18" /></button>
            </header>

            <div class="media-preview__content">
              <div class="media-preview__canvas">
                <div v-if="selectedStatus === 'missing'" class="media-preview__missing" role="status"><Icon name="image" :size="34" /><strong>图床原图已缺失</strong><span>仍可查看引用关系并清理记录。</span></div>
                <img v-else :src="selectedImage.url" :alt="selectedImage.name || '图片预览'">
              </div>
              <aside>
                <div class="media-preview__facts">
                  <span><small>状态</small><strong>{{ mediaStatusLabel(selectedImage) }}</strong></span>
                  <span><small>规格</small><strong>{{ formatMediaDimensions(selectedImage) }}</strong></span>
                  <span><small>大小</small><strong>{{ formatMediaBytes(selectedImage.size) }}</strong></span>
                </div>

                <section class="retention-card" aria-labelledby="retention-title">
                  <div>
                    <h3 id="retention-title">保留策略</h3>
                    <p v-if="mediaNeedsRetention(selectedImage)">自动清理：最后一处笔记引用移除后，原图才会删除。</p>
                    <p v-else>长期保留：即使没有笔记引用，公开链接也会继续有效。</p>
                  </div>
                  <div class="retention-switch" role="group" aria-label="图片保留策略">
                    <button type="button" :class="{ 'is-active': mediaNeedsRetention(selectedImage) }" :disabled="Boolean(busyImageId)" @click="requestRetention(selectedImage, 'auto')">自动</button>
                    <button type="button" :class="{ 'is-active': !mediaNeedsRetention(selectedImage) }" :disabled="Boolean(busyImageId)" @click="requestRetention(selectedImage, 'keep')">保留</button>
                  </div>
                  <div v-if="retentionConfirming" class="retention-warning" role="alert">
                    <p>这张图片没有笔记引用。改为“自动”后会进入清理范围，公开链接可能失效。</p>
                    <div>
                      <button type="button" @click="retentionConfirming = false">取消</button>
                      <button type="button" :disabled="Boolean(busyImageId)" @click="setRetention(selectedImage, 'auto'); retentionConfirming = false">仍改为自动</button>
                    </div>
                  </div>
                </section>

                <section class="media-preview__references" aria-labelledby="reference-title">
                  <h3 id="reference-title">引用位置 <span>{{ Number(selectedImage.referenceCount || selectedImage.references?.length || 0) }}</span></h3>
                  <div v-if="selectedImage.references?.length" class="reference-list">
                    <button v-for="reference in selectedImage.references" :key="reference.noteId || reference.id" type="button" @click="openReference(reference)">
                      <Icon name="note" :size="16" />
                      <span><strong>{{ reference.title || '加密笔记' }}</strong><small>{{ reference.numberId ? `#${reference.numberId}` : '打开笔记' }}</small></span>
                      <Icon name="external-link" :size="14" />
                    </button>
                  </div>
                  <p v-else>当前没有笔记引用。若保留策略为“自动”，可安全清理原图。</p>
                </section>

                <div class="media-preview__actions">
                  <button type="button" :disabled="Boolean(busyImageId) || !mediaCanShare(selectedImage)" @click="copyPublicLink(selectedImage)"><Icon name="link" :size="17" />复制链接</button>
                  <button type="button" :disabled="Boolean(busyImageId) || !mediaCanShare(selectedImage)" @click="copyMarkdown(selectedImage)"><Icon name="code" :size="17" />复制 Markdown</button>
                  <button type="button" :disabled="Boolean(busyImageId) || !mediaCanShare(selectedImage)" @click="shareImage(selectedImage)"><Icon name="share" :size="17" />系统分享</button>
                  <a :href="selectedImage.url" target="_blank" rel="noopener noreferrer"><Icon name="external-link" :size="17" />打开原图</a>
                </div>
                <p class="share-retention-note"><Icon name="pin" :size="15" />复制或分享前会自动设为长期保留，避免之后移除笔记引用导致链接失效。</p>

                <div v-if="selectedStatus === 'cleanup_pending'" class="cleanup-panel">
                  <p>上次清理没有完成，原图可能仍存在。</p>
                  <button type="button" :disabled="Boolean(busyImageId)" @click="retryDelete(selectedImage)"><Icon name="refresh" :size="16" />重试清理</button>
                </div>

                <div class="danger-zone">
                  <template v-if="!mediaCanDelete(selectedImage)">
                    <p><strong>图片仍被笔记引用，不能删除原图。</strong>先从上方列出的所有笔记移除图片，再返回清理。</p>
                  </template>
                  <template v-else-if="deleteConfirming">
                    <p><strong>确定删除原图？</strong>删除后图床记录无法恢复；缓存可能在部分节点短暂保留。</p>
                    <div>
                      <button type="button" :disabled="Boolean(busyImageId)" @click="deleteConfirming = false">取消</button>
                      <button class="is-danger" type="button" :disabled="Boolean(busyImageId)" @click="performDelete(selectedImage)"><Icon name="trash" :size="16" />永久删除</button>
                    </div>
                  </template>
                  <button v-else class="danger-zone__trigger" type="button" :disabled="Boolean(busyImageId)" @click="deleteConfirming = true"><Icon name="trash" :size="16" />删除原图</button>
                </div>
              </aside>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>

    <p v-if="statusMessage" class="media-toast" role="status" aria-live="polite">{{ statusMessage }}</p>
  </div>
</template>

<style scoped>
.media-page { min-height: 100vh; color: var(--text-primary); background: var(--bg-primary); }
.media-header { position: sticky; top: 0; z-index: 40; display: flex; min-height: 72px; padding: 12px clamp(16px, 4vw, 48px); align-items: center; justify-content: space-between; gap: 20px; background: color-mix(in srgb, var(--bg-primary) 88%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(18px); }
.media-header__left, .media-header__nav, .media-header__nav button { display: flex; align-items: center; }
.media-header__left { gap: 13px; }
.media-header__left p, .media-hero__eyebrow, .media-preview header p { margin: 0 0 3px; color: var(--accent-color); font-size: .68rem; font-weight: 750; letter-spacing: .13em; }
.media-header h1 { margin: 0; font-size: 1.28rem; letter-spacing: -.035em; }
.icon-button, .media-preview header button { display: grid; width: 44px; height: 44px; padding: 0; place-items: center; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px; cursor: pointer; }
.media-header__nav { gap: 8px; }
.media-header__nav button { min-height: 42px; padding: 0 13px; gap: 7px; color: var(--text-secondary); background: transparent; border: 1px solid transparent; border-radius: 12px; cursor: pointer; }
.media-header__nav button:hover, .media-header__nav button:focus-visible { color: var(--text-primary); background: var(--bg-hover); border-color: var(--border-light); }
.media-main { width: min(1480px, 100%); margin: 0 auto; padding: clamp(24px, 5vw, 64px) clamp(14px, 3vw, 38px) 100px; }
.media-hero { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.media-hero h2 { margin: 0; font-size: clamp(1.7rem, 5vw, 3.25rem); letter-spacing: -.055em; }
.media-hero > div > p:last-child { max-width: 680px; margin: 11px 0 0; color: var(--text-secondary); line-height: 1.65; }
.media-hero__legend { display: grid; gap: 7px; padding: 14px 16px; color: var(--text-secondary); font-size: .75rem; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 16px; }
.media-hero__legend span { display: flex; align-items: center; gap: 7px; }.media-hero__legend button { display: flex; min-height: 40px; margin-top: 4px; padding: 0 10px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); font: inherit; font-size: .75rem; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px; cursor: pointer; }
.media-toolbar { display: grid; grid-template-columns: minmax(180px, 390px) auto minmax(0, 1fr); gap: 10px; margin-bottom: 24px; align-items: center; }
.media-search { display: flex; min-height: 46px; padding: 0 14px; align-items: center; gap: 9px; color: var(--text-muted); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px; }
.media-search:focus-within { color: var(--accent-color); border-color: var(--accent-color); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-color) 10%, transparent); }
.media-search input { min-width: 0; flex: 1; color: var(--text-primary); font: inherit; background: transparent; border: 0; outline: 0; }
.toolbar-search-button, .media-load-more, .media-state button { min-height: 44px; padding: 0 16px; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 13px; cursor: pointer; }
.media-filters { display: flex; justify-content: flex-end; gap: 7px; overflow-x: auto; scrollbar-width: none; }
.media-filters button { display: inline-flex; min-height: 42px; padding: 0 12px; align-items: center; gap: 7px; color: var(--text-secondary); white-space: nowrap; font: inherit; font-size: .82rem; background: transparent; border: 1px solid var(--border-light); border-radius: 999px; cursor: pointer; }
.media-filters button.is-active { color: var(--bg-card); background: var(--accent-color); border-color: var(--accent-color); }
.media-filters button span { font-size: .69rem; opacity: .78; }
.media-waterfall { columns: 5 220px; column-gap: 16px; }
.media-card { position: relative; display: inline-block; width: 100%; margin: 0 0 16px; overflow: hidden; break-inside: avoid; vertical-align: top; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 18px; box-shadow: var(--shadow-sm); transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.media-card:hover { border-color: color-mix(in srgb, var(--accent-color) 34%, var(--border-light)); box-shadow: var(--shadow-card); transform: translateY(-2px); }
.media-card__preview { display: block; width: 100%; min-height: 120px; padding: 0; background: var(--bg-tertiary); border: 0; cursor: zoom-in; }
.media-card__preview img { display: block; width: 100%; height: auto; min-height: 120px; object-fit: cover; }.media-card__missing { display: grid; min-height: 180px; place-items: center; color: var(--text-muted); background: repeating-linear-gradient(135deg, var(--bg-secondary), var(--bg-secondary) 12px, var(--bg-tertiary) 12px, var(--bg-tertiary) 24px); }
.media-card__overlay-actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; opacity: 0; transform: translateY(-4px); transition: opacity .16s ease, transform .16s ease; }
.media-card:hover .media-card__overlay-actions, .media-card:focus-within .media-card__overlay-actions { opacity: 1; transform: none; }
.media-card__overlay-actions button { display: grid; width: 40px; height: 40px; padding: 0; place-items: center; color: #fff; background: rgba(34, 25, 20, .78); border: 1px solid rgba(255,255,255,.22); border-radius: 12px; backdrop-filter: blur(8px); cursor: pointer; }
.media-card__body { padding: 13px 14px 15px; }
.media-card__status-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.media-status, .media-retention { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: .68rem; }
.media-status i { width: 7px; height: 7px; background: var(--success-color); border-radius: 50%; }
.is-unreferenced .media-status i { background: var(--info-color); }.is-cleanup_pending .media-status i { background: var(--warning-color); }.is-missing .media-status i { background: var(--error-color); }
.media-card h3 { margin: 10px 0 5px; overflow: hidden; font-size: .9rem; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.media-card p, .media-card small { margin: 0; color: var(--text-muted); font-size: .7rem; }.media-card small { display: block; margin-top: 5px; }
.media-state { display: grid; min-height: 340px; place-items: center; align-content: center; gap: 9px; color: var(--text-muted); text-align: center; background: var(--bg-secondary); border: 1px dashed var(--border-color); border-radius: 24px; }
.media-state strong { color: var(--text-primary); }.media-state p { max-width: 440px; margin: 0 14px; }.media-state button { display: inline-flex; align-items: center; gap: 7px; margin-top: 6px; }.media-state--error { color: var(--error-color); }
.media-spinner { width: 22px; height: 22px; border: 2px solid var(--border-color); border-top-color: var(--accent-color); border-radius: 50%; animation: spin .8s linear infinite; }
.media-sentinel { height: 1px; }.media-loading-more, .media-inline-error { display: flex; min-height: 54px; align-items: center; justify-content: center; gap: 9px; color: var(--text-muted); font-size: .8rem; }.media-load-more { display: block; margin: 24px auto 0; }.media-inline-error { color: var(--error-color); }
.media-preview { position: fixed; inset: 0; z-index: 1300; display: grid; place-items: center; padding: 20px; overflow: auto; background: color-mix(in srgb, #1b1511 68%, transparent); backdrop-filter: blur(15px); }
.media-preview__dialog { width: min(1180px, 100%); max-height: min(900px, calc(100dvh - 40px)); overflow: hidden; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 25px; box-shadow: 0 28px 90px rgba(25,18,14,.3); outline: 0; }
.media-preview header { display: flex; min-height: 72px; padding: 14px 18px 14px 24px; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border-light); }
.media-preview header h2 { max-width: 720px; margin: 0; overflow: hidden; font-size: 1.08rem; text-overflow: ellipsis; white-space: nowrap; }
.media-preview__content { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(320px, .75fr); max-height: calc(min(900px, 100dvh - 40px) - 72px); }
.media-preview__canvas { display: grid; min-height: 420px; padding: 20px; place-items: center; overflow: auto; background: var(--bg-secondary); }
.media-preview__canvas img { max-width: 100%; max-height: 720px; object-fit: contain; border-radius: 12px; box-shadow: var(--shadow-md); }.media-preview__missing { display: grid; place-items: center; gap: 7px; color: var(--text-muted); text-align: center; }.media-preview__missing strong { color: var(--text-primary); }
.media-preview aside { padding: 20px; overflow-y: auto; border-left: 1px solid var(--border-light); }
.media-preview__facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }.media-preview__facts span { display: grid; gap: 4px; padding: 11px; background: var(--bg-secondary); border-radius: 12px; }.media-preview__facts small { color: var(--text-muted); font-size: .66rem; }.media-preview__facts strong { font-size: .76rem; }
.retention-card, .media-preview__references, .danger-zone, .cleanup-panel { margin-top: 14px; padding: 14px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 15px; }
.retention-card h3, .media-preview__references h3 { margin: 0; font-size: .86rem; }.retention-card p, .media-preview__references > p, .danger-zone p, .cleanup-panel p { margin: 6px 0 0; color: var(--text-secondary); font-size: .74rem; line-height: 1.55; }.retention-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 11px; padding: 4px; background: var(--bg-card); border-radius: 11px; }.retention-switch button { min-height: 38px; color: var(--text-secondary); font: inherit; font-size: .76rem; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }.retention-switch button.is-active { color: var(--text-primary); background: var(--accent-bg); box-shadow: 0 0 0 1px var(--accent-light); }
.retention-warning { margin-top: 10px; padding: 10px; background: color-mix(in srgb, var(--warning-color) 12%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 42%, var(--border-light)); border-radius: 11px; }.retention-warning p { margin: 0; color: var(--text-secondary); font-size: .71rem; line-height: 1.5; }.retention-warning div { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }.retention-warning button { min-height: 38px; padding: 0 10px; color: var(--text-primary); font: inherit; font-size: .7rem; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 9px; cursor: pointer; }
.media-preview__references h3 { display: flex; justify-content: space-between; }.media-preview__references h3 span { color: var(--accent-color); }.reference-list { display: grid; gap: 6px; margin-top: 10px; }.reference-list button { display: grid; grid-template-columns: auto minmax(0,1fr) auto; min-height: 48px; padding: 7px 9px; align-items: center; gap: 9px; color: var(--text-secondary); text-align: left; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px; cursor: pointer; }.reference-list button span { display: grid; min-width: 0; gap: 2px; }.reference-list strong { overflow: hidden; color: var(--text-primary); font-size: .76rem; text-overflow: ellipsis; white-space: nowrap; }.reference-list small { font-size: .66rem; }
.media-preview__actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 14px; }.media-preview__actions button, .media-preview__actions a, .cleanup-panel button, .danger-zone button { display: flex; min-height: 44px; padding: 0 11px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); font: inherit; font-size: .75rem; text-decoration: none; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 11px; cursor: pointer; }.share-retention-note { display: flex; margin: 9px 2px 0; align-items: flex-start; gap: 6px; color: var(--text-muted); font-size: .68rem; line-height: 1.45; }.share-retention-note svg { margin-top: 1px; flex: 0 0 auto; }
.cleanup-panel { border-color: color-mix(in srgb, var(--warning-color) 44%, var(--border-light)); }.cleanup-panel button { margin-top: 10px; }.danger-zone { border-color: color-mix(in srgb, var(--error-color) 35%, var(--border-light)); }.danger-zone > div { display: flex; gap: 7px; margin-top: 10px; justify-content: flex-end; }.danger-zone .is-danger, .danger-zone__trigger { color: var(--error-color); }.danger-zone__trigger { width: 100%; }
.media-toast { position: fixed; right: 18px; bottom: 18px; z-index: 1500; max-width: min(420px, calc(100vw - 36px)); margin: 0; padding: 13px 16px; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px; box-shadow: var(--shadow-lg); font-size: .8rem; }
.media-preview-enter-active, .media-preview-leave-active { transition: opacity .18s ease; }.media-preview-enter-active .media-preview__dialog, .media-preview-leave-active .media-preview__dialog { transition: transform .22s ease, opacity .18s ease; }.media-preview-enter-from, .media-preview-leave-to { opacity: 0; }.media-preview-enter-from .media-preview__dialog, .media-preview-leave-to .media-preview__dialog { opacity: 0; transform: translateY(12px) scale(.985); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-color) 30%, transparent); outline-offset: 2px; }
button:disabled { cursor: wait; opacity: .55; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (hover: none), (pointer: coarse), (any-hover: none), (any-pointer: coarse) { .media-card__overlay-actions { opacity: 1; transform: none; }.media-card:hover { transform: none; } }
@media (max-width: 760px) { .media-header__nav button span { display: none; }.media-hero { display: grid; }.media-hero__legend { width: 100%; }.media-toolbar { grid-template-columns: minmax(0,1fr) auto; }.media-filters { grid-column: 1 / -1; justify-content: flex-start; }.media-preview { padding: 0; align-items: end; }.media-preview__dialog { width: 100%; max-height: 92dvh; border-radius: 24px 24px 0 0; }.media-preview__content { display: block; max-height: calc(92dvh - 72px); overflow-y: auto; }.media-preview__canvas { min-height: 260px; max-height: 48dvh; }.media-preview aside { overflow: visible; border-top: 1px solid var(--border-light); border-left: 0; } }
@media (max-width: 420px) { .media-header { padding-inline: 10px; }.media-header__nav { gap: 2px; }.media-header__nav button { width: 44px; padding: 0; justify-content: center; }.media-main { padding-inline: 10px; }.media-waterfall { columns: 1; }.media-toolbar { grid-template-columns: minmax(0,1fr) 66px; }.toolbar-search-button { padding: 0 10px; }.media-preview__facts { grid-template-columns: 1fr 1fr 1fr; }.media-preview__actions { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; } }
</style>
