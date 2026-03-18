<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getNotes, addNote, updateNote, deleteNote, toggleNotePin, getSetting, setSetting } from '@/shared/db/database'
import NoteCard from './components/NoteCard.vue'
import NoteEditor from './components/NoteEditor.vue'
import ShareManager from './components/ShareManager.vue'

const router = useRouter()

// 笔记数据
const notes = ref([])
const loading = ref(true)

// 筛选
const filterType = ref('all') // all | memo | diary

// 编辑器
const showEditor = ref(false)
const editingNote = ref(null)

// 分享管理
const showShareManager = ref(false)
const sharingNote = ref(null)

// 设置弹窗
const showSettings = ref(false)
const whisperBgImage = ref('')

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

// 筛选后的笔记
const filteredNotes = computed(() => {
  if (filterType.value === 'all') return notes.value
  return notes.value.filter(n => n.type === filterType.value)
})

// 置顶的备忘录
const pinnedMemos = computed(() => {
  return filteredNotes.value.filter(n => n.type === 'memo' && n.pinned)
})

// 日记（按日期分组）
const diaryGroups = computed(() => {
  const diaries = filteredNotes.value.filter(n => n.type === 'diary')
  const groups = {}

  diaries.forEach(diary => {
    const date = new Date(diary.createdAt)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

    if (!groups[key]) {
      groups[key] = {
        label: date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }),
        items: []
      }
    }
    groups[key].items.push(diary)
  })

  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]))
})

// 非置顶的备忘录
const unpinnedMemos = computed(() => {
  return filteredNotes.value.filter(n => n.type === 'memo' && !n.pinned)
})

// 加载数据
async function loadNotes() {
  loading.value = true
  notes.value = await getNotes()
  loading.value = false
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

// 保存笔记
async function handleSaveNote(data) {
  if (editingNote.value?.id) {
    await updateNote(editingNote.value.id, data)
  } else {
    await addNote(data)
  }

  showEditor.value = false
  editingNote.value = null
  await loadNotes()
}

// 删除笔记
async function handleDeleteNote(note) {
  if (!confirm(`确定删除「${note.title}」？`)) return
  await deleteNote(note.id)
  await loadNotes()
}

// 切换置顶
async function handleTogglePin(note) {
  await toggleNotePin(note.id)
  await loadNotes()
}

// 分享笔记
function handleShareNote(note) {
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
        <button class="header__btn" @click="goBack">←</button>
        <h1 class="header__title">📖 时光</h1>
      </div>
      <div class="header__actions">
        <button class="header__btn" @click="showSettings = true" title="设置">⚙️</button>
        <button class="btn btn--primary" @click="handleCreateNote('memo')">
          ➕ 新建
        </button>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="main">
      <!-- 筛选标签 -->
      <div class="filter-tabs">
        <button
          class="filter-tab"
          :class="{ 'is-active': filterType === 'all' }"
          @click="filterType = 'all'"
        >
          全部
        </button>
        <button
          class="filter-tab"
          :class="{ 'is-active': filterType === 'memo' }"
          @click="filterType = 'memo'"
        >
          📋 备忘录
        </button>
        <button
          class="filter-tab"
          :class="{ 'is-active': filterType === 'diary' }"
          @click="filterType = 'diary'"
        >
          📖 日记
        </button>
      </div>

      <!-- 加载中 -->
      <div v-if="loading" class="loading">
        <span class="loading__spinner">⏳</span>
        <span>加载中...</span>
      </div>

      <!-- 空状态 -->
      <div v-else-if="notes.length === 0" class="empty-state">
        <div class="empty-state__icon">📝</div>
        <div class="empty-state__title">开始记录你的时光</div>
        <div class="empty-state__desc">创建备忘录记录重要信息，或写日记记录生活点滴</div>
        <div class="empty-state__actions">
          <button class="btn btn--primary" @click="handleCreateNote('memo')">
            📋 新建备忘录
          </button>
          <button class="btn btn--secondary" @click="handleCreateNote('diary')">
            📖 写日记
          </button>
        </div>
      </div>

      <!-- 内容区域 -->
      <div v-else class="content">
        <!-- 置顶备忘录 -->
        <section v-if="pinnedMemos.length > 0" class="section">
          <h2 class="section__title">📌 置顶</h2>
          <div class="notes-grid">
            <NoteCard
              v-for="note in pinnedMemos"
              :key="note.id"
              :note="note"
              @edit="handleEditNote"
              @delete="handleDeleteNote"
              @togglePin="handleTogglePin"
              @share="handleShareNote"
            />
          </div>
        </section>

        <!-- 日记时间线 -->
        <section v-if="diaryGroups.length > 0 && (filterType === 'all' || filterType === 'diary')" class="section">
          <h2 class="section__title">📖 日记</h2>
          <div v-for="[key, group] in diaryGroups" :key="key" class="diary-group">
            <h3 class="diary-group__title">{{ group.label }}</h3>
            <div class="notes-grid">
              <NoteCard
                v-for="note in group.items"
                :key="note.id"
                :note="note"
                @edit="handleEditNote"
                @delete="handleDeleteNote"
                @togglePin="handleTogglePin"
                @share="handleShareNote"
              />
            </div>
          </div>
        </section>

        <!-- 备忘录 -->
        <section v-if="unpinnedMemos.length > 0 && (filterType === 'all' || filterType === 'memo')" class="section">
          <h2 class="section__title">📋 备忘录</h2>
          <div class="notes-grid">
            <NoteCard
              v-for="note in unpinnedMemos"
              :key="note.id"
              :note="note"
              @edit="handleEditNote"
              @delete="handleDeleteNote"
              @togglePin="handleTogglePin"
              @share="handleShareNote"
            />
          </div>
        </section>
      </div>
    </main>

    <!-- 新建浮动按钮 -->
    <div class="fab-group">
      <button class="fab fab--memo" title="新建备忘录" @click="handleCreateNote('memo')">
        📋
      </button>
      <button class="fab fab--diary" title="写日记" @click="handleCreateNote('diary')">
        📖
      </button>
    </div>

    <!-- 编辑器弹窗 -->
    <NoteEditor
      :show="showEditor"
      :note="editingNote"
      @close="showEditor = false; editingNote = null"
      @save="handleSaveNote"
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
          <h3>⚙️ 时光设置</h3>
          <button class="settings-modal__close" @click="showSettings = false">✕</button>
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
                  <button class="bg-clear" @click="clearBgImage">✕</button>
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

/* 筛选标签 */
.filter-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
}

.filter-tab {
  flex: 1;
  padding: 10px 20px;
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
  font-size: 64px;
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

@media (max-width: 640px) {
  .header {
    padding: 0 16px;
  }

  .main {
    padding: 16px;
  }

  .notes-grid {
    grid-template-columns: 1fr;
  }

  .fab-group {
    bottom: 16px;
    right: 16px;
  }
}
</style>
