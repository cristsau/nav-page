<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getCurrentUserId, getNotes as getLocalNotes, addNote as addLocalNote, updateNote as updateLocalNote, deleteNote as deleteLocalNote, toggleNotePin as toggleLocalNotePin, getSetting as getLocalSetting, setSetting as setLocalSetting } from '@/shared/db/database'
import { fetchBackendSetting, saveBackendSetting, shouldUseBackendSettings } from '@/shared/services/settingsApi'
import { createBackendNote, deleteBackendNote, fetchBackendNotes, shouldUseBackendNotes, toggleBackendNotePin, updateBackendNote } from '@/shared/services/notesApi'
import Icon from '@/shared/components/Icon.vue'
import NoteCard from './components/NoteCard.vue'
import NoteEditor from './components/NoteEditor.vue'
import NotePreview from './components/NotePreview.vue'
import ShareManager from './components/ShareManager.vue'

const router = useRouter()

// 笔记数据
const notes = ref([])
const loading = ref(true)
const savingNote = ref(false)
const status = ref({ message: '', type: '' })
let statusTimer = null

// 筛选
const filterType = ref('all') // all | memo | diary
const memoStatus = ref('open') // open | completed | all
const searchQuery = ref('')

// 编辑器
const showEditor = ref(false)
const editingNote = ref(null)
const showPreview = ref(false)
const previewingNote = ref(null)

// 分享管理
const showShareManager = ref(false)
const sharingNote = ref(null)

// 设置弹窗
const showSettings = ref(false)
const whisperBgImage = ref('')

function canUseBackendSettings() {
  return shouldUseBackendSettings() && Boolean(getCurrentUserId())
}

async function getSetting(key) {
  if (canUseBackendSettings()) {
    return fetchBackendSetting(key)
  }

  return getLocalSetting(key)
}

async function setSetting(key, value) {
  if (canUseBackendSettings()) {
    return saveBackendSetting(key, value)
  }

  return setLocalSetting(key, value)
}

async function getNotes() {
  return shouldUseBackendNotes()
    ? fetchBackendNotes()
    : getLocalNotes()
}

async function addNote(note) {
  return shouldUseBackendNotes()
    ? createBackendNote(note)
    : addLocalNote(note)
}

async function updateNote(id, updates) {
  return shouldUseBackendNotes()
    ? updateBackendNote(id, updates)
    : updateLocalNote(id, updates)
}

async function deleteNote(id) {
  return shouldUseBackendNotes()
    ? deleteBackendNote(id)
    : deleteLocalNote(id)
}

async function toggleNotePin(id) {
  return shouldUseBackendNotes()
    ? toggleBackendNotePin(id)
    : toggleLocalNotePin(id)
}

// 背景图样式
const bgStyle = computed(() => {
  if (whisperBgImage.value) {
    return {
      backgroundImage: `url(${whisperBgImage.value})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed'
    }
  }
  return null
})

function setStatus(message, type = 'success') {
  status.value = { message, type }
  if (statusTimer) window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    status.value = { message: '', type: '' }
  }, 3200)
}

// 筛选后的笔记
const filteredNotes = computed(() => {
  const term = searchQuery.value.trim().toLowerCase()

  return notes.value.filter((note) => {
    if (filterType.value !== 'all' && note.type !== filterType.value) return false

    if (note.type === 'memo' && memoStatus.value !== 'all') {
      if (memoStatus.value === 'completed' && !note.completed) return false
      if (memoStatus.value === 'open' && note.completed) return false
    }

    if (!term) return true

    return [
      note.title,
      note.encrypted ? '' : note.content,
      ...(note.tags || []),
      note.mood || ''
    ].some((value) => String(value || '').toLowerCase().includes(term))
  })
})

const noteStats = computed(() => ({
  openMemos: notes.value.filter((note) => note.type === 'memo' && !note.completed).length,
  completedMemos: notes.value.filter((note) => note.type === 'memo' && note.completed).length,
  diaries: notes.value.filter((note) => note.type === 'diary').length
}))

// 置顶的备忘录
const pinnedMemos = computed(() => {
  return filteredNotes.value.filter(n => n.type === 'memo' && n.pinned)
})

// 日记（按日期分组）
const diaryGroups = computed(() => {
  const diaries = filteredNotes.value.filter(n => n.type === 'diary')
  const groups = {}

  diaries.forEach(diary => {
    const date = diary.entryDate
      ? new Date(`${diary.entryDate}T00:00:00`)
      : new Date(diary.createdAt)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

    if (!groups[key]) {
      groups[key] = {
        label: date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }),
        items: []
      }
    }
    groups[key].items.push(diary)
  })

  for (const group of Object.values(groups)) {
    group.items.sort((a, b) => {
      const aDate = a.entryDate || String(a.createdAt)
      const bDate = b.entryDate || String(b.createdAt)
      return bDate.localeCompare(aDate)
    })
  }

  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]))
})

// 非置顶的备忘录
const unpinnedMemos = computed(() => {
  return filteredNotes.value.filter(n => n.type === 'memo' && !n.pinned)
})

// 加载数据
async function loadNotes() {
  loading.value = true
  try {
    notes.value = await getNotes()
  } catch (e) {
    console.error('Failed to load notes:', e)
    alert('加载笔记失败，请刷新页面后重试。')
  } finally {
    loading.value = false
  }
}

// 新建笔记
function handleCreateNote(type = 'memo') {
  editingNote.value = { type }
  showEditor.value = true
}

// 编辑笔记
function handleEditNote(note) {
  editingNote.value = { ...note }
  showEditor.value = true
}

function handlePreviewNote(note) {
  previewingNote.value = note
  showPreview.value = true
}

// 保存笔记
async function handleSaveNote(data) {
  savingNote.value = true
  try {
    if (editingNote.value?.id) {
      await updateNote(editingNote.value.id, data)
    } else {
      await addNote(data)
    }

    showEditor.value = false
    editingNote.value = null
    await loadNotes()
    setStatus('笔记已保存')
  } catch (e) {
    console.error('Failed to save note:', e)
    alert(`保存失败：${e.message || '请稍后重试'}`)
    setStatus(`保存失败：${e.message || '请稍后重试'}`, 'error')
  } finally {
    savingNote.value = false
  }
}

// 删除笔记
async function handleDeleteNote(note) {
  if (!confirm(`确定删除「${note.title}」？`)) return
  try {
    await deleteNote(note.id)
    await loadNotes()
    setStatus(`「${note.title}」已删除`)
  } catch (error) {
    setStatus(`删除失败：${error.message || '请稍后重试'}`, 'error')
  }
}

// 切换置顶
async function handleTogglePin(note) {
  try {
    await toggleNotePin(note.id)
    await loadNotes()
  } catch (error) {
    setStatus(`置顶操作失败：${error.message || '请稍后重试'}`, 'error')
  }
}

async function handleToggleComplete(note) {
  try {
    await updateNote(note.id, { completed: !note.completed })
    await loadNotes()
    setStatus(note.completed ? '已恢复为待办' : '备忘录已完成')
  } catch (error) {
    setStatus(`状态更新失败：${error.message || '请稍后重试'}`, 'error')
  }
}

// 分享笔记
function handleShareNote(note) {
  if (note.encrypted) {
    setStatus('加密笔记不能创建公开分享', 'error')
    return
  }
  sharingNote.value = note
  showShareManager.value = true
}

// 上传背景图
function handleBgUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = async (event) => {
    whisperBgImage.value = event.target.result
    await setSetting('whisperBgImage', event.target.result)
  }
  reader.readAsDataURL(file)
}

// 清除背景图
async function clearBgImage() {
  whisperBgImage.value = ''
  await setSetting('whisperBgImage', '')
}

// 返回首页
function goBack() {
  router.push('/')
}

// 初始化
onMounted(async () => {
  await loadNotes()
  // 加载时光模块背景图
  const bg = await getSetting('whisperBgImage')
  if (bg) whisperBgImage.value = bg
})
</script>

<template>
  <div class="page" :style="bgStyle">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="header__left">
        <button class="header__btn" type="button" aria-label="返回导航页" @click="goBack">
          <Icon name="arrow-left" :size="20" />
        </button>
        <div>
          <div class="header__eyebrow">DOMO NAV</div>
          <h1 class="header__title">日记与备忘录</h1>
        </div>
      </div>
      <div class="header__actions">
        <button class="header__btn" type="button" aria-label="打开页面设置" title="设置" @click="showSettings = true">
          <Icon name="settings" :size="18" />
        </button>
        <button class="header__btn header__diary-btn" type="button" aria-label="写日记" title="写日记" @click="handleCreateNote('diary')">
          <Icon name="book" :size="18" />
        </button>
        <button class="btn btn--primary" type="button" @click="handleCreateNote('memo')">
          <Icon name="plus" :size="17" /> 新建
        </button>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="main">
      <section class="overview-strip" aria-label="记录概览">
        <div><strong>{{ noteStats.openMemos }}</strong><span>待办备忘</span></div>
        <div><strong>{{ noteStats.completedMemos }}</strong><span>已完成</span></div>
        <div><strong>{{ noteStats.diaries }}</strong><span>日记</span></div>
      </section>

      <div class="notes-toolbar">
        <label class="notes-search">
          <Icon name="search" :size="18" />
          <input v-model="searchQuery" type="search" placeholder="搜索标题、正文或标签">
        </label>

        <div class="filter-tabs" aria-label="笔记类型">
          <button
            type="button"
            class="filter-tab"
            :class="{ 'is-active': filterType === 'all' }"
            @click="filterType = 'all'"
          >
            全部
          </button>
          <button
            type="button"
            class="filter-tab"
            :class="{ 'is-active': filterType === 'memo' }"
            @click="filterType = 'memo'"
          >
            <Icon name="list" :size="16" /> 备忘录
          </button>
          <button
            type="button"
            class="filter-tab"
            :class="{ 'is-active': filterType === 'diary' }"
            @click="filterType = 'diary'"
          >
            <Icon name="book" :size="16" /> 日记
          </button>
        </div>
      </div>

      <div v-if="filterType !== 'diary'" class="memo-status-filter" aria-label="备忘录状态">
        <button type="button" :class="{ 'is-active': memoStatus === 'open' }" @click="memoStatus = 'open'">待完成</button>
        <button type="button" :class="{ 'is-active': memoStatus === 'completed' }" @click="memoStatus = 'completed'">已完成</button>
        <button type="button" :class="{ 'is-active': memoStatus === 'all' }" @click="memoStatus = 'all'">全部状态</button>
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="loading">
        <span class="loading__spinner" aria-hidden="true"></span>
        <span>加载中...</span>
      </div>

      <!-- 空状态 -->
      <div v-else-if="notes.length === 0" class="empty-state">
        <div class="empty-state__icon"><Icon name="note" :size="48" /></div>
        <div class="empty-state__title">开始记录你的时光</div>
        <div class="empty-state__desc">创建备忘录记录重要信息，或写日记记录生活点滴</div>
        <div class="empty-state__actions">
          <button class="btn btn--primary" type="button" @click="handleCreateNote('memo')">
            <Icon name="list" :size="17" /> 新建备忘录
          </button>
          <button class="btn btn--secondary" type="button" @click="handleCreateNote('diary')">
            <Icon name="book" :size="17" /> 写日记
          </button>
        </div>
      </div>

      <div v-else-if="filteredNotes.length === 0" class="empty-state empty-state--compact">
        <div class="empty-state__icon"><Icon name="search" :size="40" /></div>
        <div class="empty-state__title">没有匹配的记录</div>
        <div class="empty-state__desc">试试清空搜索词或切换筛选条件。</div>
      </div>

      <!-- 内容区域 -->
      <div v-else class="content">
        <!-- 置顶备忘录 -->
        <section v-if="pinnedMemos.length > 0" class="section">
          <h2 class="section__title"><Icon name="pin" :size="17" /> 置顶</h2>
          <div class="notes-grid">
            <NoteCard
              v-for="note in pinnedMemos"
              :key="note.id"
              :note="note"
              @preview="handlePreviewNote"
              @edit="handleEditNote"
              @delete="handleDeleteNote"
              @togglePin="handleTogglePin"
              @toggleComplete="handleToggleComplete"
              @share="handleShareNote"
            />
          </div>
        </section>

        <!-- 日记时间线 -->
        <section v-if="diaryGroups.length > 0 && (filterType === 'all' || filterType === 'diary')" class="section">
          <h2 class="section__title"><Icon name="book" :size="17" /> 日记</h2>
          <div v-for="[key, group] in diaryGroups" :key="key" class="diary-group">
            <h3 class="diary-group__title">{{ group.label }}</h3>
            <div class="notes-grid">
              <NoteCard
                v-for="note in group.items"
                :key="note.id"
                :note="note"
                @preview="handlePreviewNote"
                @edit="handleEditNote"
                @delete="handleDeleteNote"
                @togglePin="handleTogglePin"
                @toggleComplete="handleToggleComplete"
                @share="handleShareNote"
              />
            </div>
          </div>
        </section>

        <!-- 备忘录 -->
        <section v-if="unpinnedMemos.length > 0 && (filterType === 'all' || filterType === 'memo')" class="section">
          <h2 class="section__title"><Icon name="list" :size="17" /> 备忘录</h2>
          <div class="notes-grid">
            <NoteCard
              v-for="note in unpinnedMemos"
              :key="note.id"
              :note="note"
              @preview="handlePreviewNote"
              @edit="handleEditNote"
              @delete="handleDeleteNote"
              @togglePin="handleTogglePin"
              @toggleComplete="handleToggleComplete"
              @share="handleShareNote"
            />
          </div>
        </section>
      </div>
    </main>

    <!-- 新建浮动按钮 -->
    <div class="fab-group">
      <button class="fab fab--memo" type="button" aria-label="新建备忘录" title="新建备忘录" @click="handleCreateNote('memo')">
        <Icon name="list" :size="22" />
      </button>
      <button class="fab fab--diary" type="button" aria-label="写日记" title="写日记" @click="handleCreateNote('diary')">
        <Icon name="book" :size="22" />
      </button>
    </div>

    <!-- 编辑器弹窗 -->
    <NoteEditor
      :show="showEditor"
      :note="editingNote"
      :saving="savingNote"
      @close="showEditor = false; editingNote = null"
      @save="handleSaveNote"
    />

    <NotePreview
      :show="showPreview"
      :note="previewingNote"
      @close="showPreview = false; previewingNote = null"
      @edit="showPreview = false; handleEditNote($event)"
    />

    <!-- 分享管理弹窗 -->
    <ShareManager
      :show="showShareManager"
      :note="sharingNote"
      @close="showShareManager = false; sharingNote = null"
      @shared="loadNotes"
      @cancelled="loadNotes"
    />

    <!-- 设置弹窗 -->
    <div v-if="showSettings" class="settings-modal" @click.self="showSettings = false">
      <div class="settings-modal__content">
        <div class="settings-modal__header">
          <h3>页面设置</h3>
          <button type="button" class="settings-modal__close" aria-label="关闭设置" @click="showSettings = false">
            <Icon name="close" :size="17" />
          </button>
        </div>
        <div class="settings-modal__body">
          <!-- 背景图 -->
          <div class="settings-item">
            <div class="settings-item__info">
              <div class="settings-item__label">页面背景图</div>
              <div class="settings-item__desc">自定义时光页面背景</div>
            </div>
            <div class="settings-item__control">
              <div class="bg-upload">
                <div v-if="whisperBgImage" class="bg-preview">
                  <img :src="whisperBgImage" alt="背景预览">
                  <button type="button" class="bg-clear" aria-label="清除背景图" @click="clearBgImage">
                    <Icon name="close" :size="12" />
                  </button>
                </div>
                <label class="upload-btn">
                  {{ whisperBgImage ? '更换' : '上传图片' }}
                  <input type="file" accept="image/*" hidden @change="handleBgUpload">
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Transition name="toast">
      <div
        v-if="status.message"
        class="toast"
        :class="`is-${status.type}`"
        role="status"
        aria-live="polite"
      >
        <Icon :name="status.type === 'error' ? 'circle-x' : 'circle-check'" :size="18" />
        {{ status.message }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-primary);
}

/* 顶部导航 */
.header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 24px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-light);
}

.header__left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header__btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  font-size: 18px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.header__btn:hover {
  background: var(--bg-hover);
}

.header__title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.header__eyebrow {
  margin-bottom: 2px;
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header__actions .header__btn {
  width: 36px;
  height: 36px;
  font-size: 16px;
}

.header__actions .btn--primary {
  padding: 8px 16px;
  font-size: 13px;
  white-space: nowrap;
}

/* 主内容 */
.main {
  max-width: 1000px;
  margin: 0 auto;
  padding: 24px;
  padding-bottom: 100px;
}

.overview-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-bottom: 16px;
  overflow: hidden;
  background: var(--border-light);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}

.overview-strip > div {
  display: grid;
  gap: 3px;
  padding: 16px 18px;
  background: color-mix(in srgb, var(--bg-card) 94%, var(--accent-color));
}

.overview-strip strong {
  color: var(--text-primary);
  font-size: 22px;
}

.overview-strip span {
  color: var(--text-muted);
  font-size: 12px;
}

.notes-toolbar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) auto;
  gap: 12px;
  align-items: stretch;
}

.notes-search {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 48px;
  padding: 0 15px;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}

.notes-search:focus-within {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 18%, transparent);
}

.notes-search input {
  min-width: 0;
  flex: 1;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 14px;
}

.notes-search input::placeholder {
  color: var(--text-muted);
}

/* 筛选标签 */
.filter-tabs {
  display: flex;
  gap: 8px;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
}

.filter-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.filter-tab:hover {
  color: var(--text-primary);
}

.filter-tab.is-active {
  background: var(--bg-card);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.memo-status-filter {
  display: flex;
  gap: 7px;
  margin: 12px 0 24px;
}

.memo-status-filter button {
  min-height: 34px;
  padding: 6px 12px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-light);
  border-radius: 999px;
  cursor: pointer;
}

.memo-status-filter button:hover,
.memo-status-filter button.is-active {
  color: var(--text-primary);
  background: var(--bg-card);
  border-color: var(--accent-color);
}

/* 加载中 */
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px;
  color: var(--text-muted);
}

.loading__spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 80px 20px;
}

.empty-state__icon {
  width: 78px;
  height: 78px;
  display: grid;
  place-items: center;
  margin: 0 auto 20px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 24px;
}

.empty-state--compact {
  padding-block: 48px;
}

.empty-state--compact .empty-state__icon {
  width: 64px;
  height: 64px;
  margin-bottom: 20px;
}

.empty-state__title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.empty-state__desc {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 24px;
}

.empty-state__actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* 内容区域 */
.section {
  margin-bottom: 32px;
}

.section__title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--border-light);
}

.diary-group {
  margin-bottom: 24px;
}

.diary-group__title {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

/* 笔记网格 */
.notes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

/* 浮动按钮组 */
.fab-group {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 50;
}

.fab {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  font-size: 24px;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  transition: all var(--transition-fast);
}

.fab:hover {
  transform: scale(1.1);
}

.fab--memo {
  background: var(--accent-color);
}

.fab--diary {
  background: var(--success-color);
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--primary:hover {
  background: var(--accent-hover);
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.btn--secondary:hover {
  background: var(--bg-hover);
}

/* 设置弹窗 */
.settings-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.settings-modal__content {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 420px;
  max-width: 90vw;
  box-shadow: var(--shadow-lg);
}

.settings-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-light);
}

.settings-modal__header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.settings-modal__close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
}

.settings-modal__close:hover {
  background: var(--bg-hover);
}

.settings-modal__body {
  padding: 20px;
}

.settings-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 0;
}

.settings-item__info {
  flex: 1;
}

.settings-item__label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.settings-item__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.settings-item__control {
  flex-shrink: 0;
}

/* 背景图上传 */
.bg-upload {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bg-preview {
  position: relative;
  width: 80px;
  height: 50px;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 2px solid var(--border-color);
}

.bg-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-clear {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--error-color);
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 10px;
  cursor: pointer;
}

.upload-btn {
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.upload-btn:hover {
  background: var(--bg-hover);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 400;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 11px 16px;
  color: #fff;
  background: color-mix(in srgb, var(--success-color) 82%, #111);
  border-radius: 999px;
  box-shadow: var(--shadow-lg);
  transform: translateX(-50%);
}

.toast.is-error {
  background: color-mix(in srgb, var(--error-color) 84%, #111);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

@media (max-width: 640px) {
  .header {
    height: auto;
    min-height: var(--header-height);
    padding: 0 16px;
  }

  .header__title {
    font-size: 17px;
  }

  .header__actions .btn--primary {
    padding-inline: 12px;
  }

  .main {
    padding: 16px;
  }

  .overview-strip > div {
    padding: 12px;
  }

  .overview-strip strong {
    font-size: 19px;
  }

  .notes-toolbar {
    grid-template-columns: 1fr;
  }

  .filter-tabs {
    width: 100%;
  }

  .filter-tab {
    flex: 1;
    padding-inline: 8px;
  }

  .memo-status-filter {
    overflow-x: auto;
    padding-bottom: 2px;
  }

  .memo-status-filter button {
    flex: 0 0 auto;
  }

  .notes-grid {
    grid-template-columns: 1fr;
  }

  .empty-state__actions {
    flex-direction: column;
  }

  .fab-group {
    display: none;
  }
}
</style>
