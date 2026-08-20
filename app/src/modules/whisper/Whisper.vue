<script setup>
import { ref, computed, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getCurrentUserId, getNotes as getLocalNotes, addNote as addLocalNote, updateNote as updateLocalNote, deleteNote as deleteLocalNote, toggleNotePin as toggleLocalNotePin, getSetting as getLocalSetting, setSetting as setLocalSetting } from '@/shared/db/database'
import { fetchBackendSetting, saveBackendSetting, shouldUseBackendSettings } from '@/shared/services/settingsApi'
import { createBackendNote, deleteBackendNote, fetchBackendNotes, shouldUseBackendNotes, toggleBackendNotePin, updateBackendNote } from '@/shared/services/notesApi'
import { COMMAND_ACTION_EVENT } from '@/shared/composables/useCommandPalette'
import { useNoteReminders } from '@/shared/composables/useNoteReminders'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import NoteCard from './components/NoteCard.vue'
import NoteEditor from './components/NoteEditor.vue'
import NotePreview from './components/NotePreview.vue'
import ReminderCenter from './components/ReminderCenter.vue'
import ShareManager from './components/ShareManager.vue'
import {
  mediaCleanupHasFailures,
  mediaCleanupMessage
} from '@/modules/media/mediaLibrary'
import { buildFullNoteText } from './utils/noteCopyText'

const router = useRouter()
const route = useRoute()

// 笔记数据
const notes = ref([])
const loading = ref(true)
const savingNote = ref(false)
const status = ref({ message: '', type: '' })
const showReminderCenter = ref(false)
let statusTimer = null

const {
  reminders,
  unreadCount: reminderUnreadCount,
  loading: remindersLoading,
  error: remindersError,
  localOnly: remindersLocalOnly,
  refresh: refreshReminders,
  markRead: markReminderRead,
  markAllRead: markAllRemindersRead
} = useNoteReminders({
  notes,
  onError: (error) => console.error('Failed to refresh note reminders:', error)
})

// 筛选
const filterType = ref('all') // all | memo | diary
const memoStatus = ref('open') // open | completed | all
const searchQuery = ref('')

// 编辑器
const showEditor = ref(false)
const editingNote = ref(null)
const showPreview = ref(false)
const previewingNote = ref(null)
const createMenuOpen = ref(false)
const createMenuRef = ref(null)
const createMenuButtonRef = ref(null)
const reminderButtonRef = ref(null)
const previewReturnFocus = ref(null)

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
  if (shouldUseBackendNotes()) {
    return updateBackendNote(id, updates, { includeCleanup: true })
  }
  await updateLocalNote(id, updates)
  return { note: null, mediaCleanup: [] }
}

async function deleteNote(id) {
  if (shouldUseBackendNotes()) {
    return deleteBackendNote(id, { includeCleanup: true })
  }
  await deleteLocalNote(id)
  return { mediaCleanup: [] }
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
  const numberTerm = term.replace(/^#/, '')

  return notes.value.filter((note) => {
    if (filterType.value !== 'all' && note.type !== filterType.value) return false

    if (note.type === 'memo' && memoStatus.value !== 'all') {
      if (memoStatus.value === 'completed' && !note.completed) return false
      if (memoStatus.value === 'open' && note.completed) return false
    }

    if (!term) return true

    const numberIdMatches = Boolean(
      numberTerm &&
      note.numberId &&
      String(note.numberId).includes(numberTerm)
    )

    return numberIdMatches || [
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

async function toggleCreateMenu() {
  createMenuOpen.value = !createMenuOpen.value

  if (createMenuOpen.value) {
    await nextTick()
    createMenuRef.value
      ?.querySelector('[role="menuitem"]')
      ?.focus()
  }
}

function chooseCreateNote(type) {
  createMenuOpen.value = false
  handleCreateNote(type)
}

function handleCreateMenuPointerDown(event) {
  if (!createMenuOpen.value || createMenuRef.value?.contains(event.target)) return
  createMenuOpen.value = false
}

function handleCreateMenuKeydown(event) {
  if (event.key !== 'Escape' || !createMenuOpen.value) return
  event.preventDefault()
  createMenuOpen.value = false
  createMenuButtonRef.value?.focus()
}

function handleCreateMenuNavigation(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return

  const items = [...(createMenuRef.value?.querySelectorAll('[role="menuitem"]') || [])]
  if (!items.length) return

  event.preventDefault()
  const currentIndex = Math.max(0, items.indexOf(document.activeElement))
  let nextIndex = currentIndex

  if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = items.length - 1
  } else {
    const direction = event.key === 'ArrowDown' ? 1 : -1
    nextIndex = (currentIndex + direction + items.length) % items.length
  }

  items[nextIndex]?.focus()
}

// 编辑笔记
function handleEditNote(note) {
  editingNote.value = { ...note }
  showEditor.value = true
}

function handleAiNote(note) {
  showPreview.value = false
  previewingNote.value = null
  editingNote.value = { ...note, _openAi: true }
  showEditor.value = true
}

function handlePreviewNote(note, returnFocus = null) {
  previewReturnFocus.value = returnFocus
  previewingNote.value = note
  showPreview.value = true
}

async function copyText(value) {
  await navigator.clipboard.writeText(value)
}

async function handleCopyNoteId(note) {
  if (!note?.numberId) {
    setStatus('这条记录暂时没有数字 ID', 'error')
    return
  }

  try {
    await copyText(String(note.numberId))
    setStatus(`已复制数字 ID #${note.numberId}`)
  } catch {
    setStatus('复制数字 ID 失败，请手动复制', 'error')
  }
}

async function handleCopyNoteExtract(note) {
  if (note.encrypted && !note._unlocked) {
    setStatus('请先解锁加密记录再快速复制', 'error')
    return
  }

  try {
    await copyText(buildFullNoteText(note))
    setStatus(`已复制 #${note.numberId || note.id} 的整条笔记内容`)
  } catch {
    setStatus('快速复制失败，请手动复制', 'error')
  }
}

async function handleCopyValue(payload) {
  const value = String(payload?.value ?? '').trim()
  const label = String(payload?.label || '内容').trim()
  if (!value) return

  try {
    await copyText(value)
    setStatus(`已复制${label === '整行' ? '整行内容' : label}`)
  } catch {
    setStatus('复制失败，请手动复制', 'error')
  }
}

// 保存笔记
async function handleSaveNote(data) {
  savingNote.value = true
  try {
    let mutationResult = null
    if (editingNote.value?.id) {
      mutationResult = await updateNote(editingNote.value.id, data)
    } else {
      await addNote(data)
    }

    showEditor.value = false
    editingNote.value = null
    await loadNotes()
    await refreshReminders()
    const mediaCleanup = mutationResult?.mediaCleanup
    const cleanupMessage = mediaCleanupMessage(mediaCleanup)
    setStatus(
      cleanupMessage ? `笔记已保存；${cleanupMessage}` : '笔记已保存',
      mediaCleanupHasFailures(mediaCleanup) ? 'error' : 'success'
    )
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
    const mutationResult = await deleteNote(note.id)
    await loadNotes()
    await refreshReminders()
    const mediaCleanup = mutationResult?.mediaCleanup
    const cleanupMessage = mediaCleanupMessage(mediaCleanup)
    setStatus(
      cleanupMessage
        ? `「${note.title}」已删除；${cleanupMessage}`
        : `「${note.title}」已删除`,
      mediaCleanupHasFailures(mediaCleanup) ? 'error' : 'success'
    )
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
    await refreshReminders()
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

function goToMedia() {
  router.push('/media')
}

async function openReminderCenter() {
  showReminderCenter.value = true
  await refreshReminders()
}

async function handleReminderRead(reminder) {
  try {
    await markReminderRead(reminder)
  } catch (error) {
    setStatus(`提醒更新失败：${error.message || '请稍后重试'}`, 'error')
  }
}

async function handleAllRemindersRead() {
  try {
    await markAllRemindersRead()
    setStatus('到期提醒已全部标为已读')
  } catch (error) {
    setStatus(`提醒更新失败：${error.message || '请稍后重试'}`, 'error')
  }
}

async function findReminderNote(reminder) {
  let note = notes.value.find((item) => String(item.id) === String(reminder.noteId))
  if (note) return note

  await loadNotes()
  note = notes.value.find((item) => String(item.id) === String(reminder.noteId))
  return note || null
}

async function handleReminderView(reminder) {
  const note = await findReminderNote(reminder)
  if (!note) {
    setStatus('对应备忘录已不存在或无权访问', 'error')
    await refreshReminders()
    return
  }

  try {
    await markReminderRead(reminder)
  } catch (error) {
    console.error('Failed to mark reminder read:', error)
  }

  showReminderCenter.value = false
  handlePreviewNote(note, reminderButtonRef.value)
}

async function handleReminderComplete(reminder) {
  const note = await findReminderNote(reminder)
  if (!note) {
    setStatus('对应备忘录已不存在或无权访问', 'error')
    await refreshReminders()
    return
  }

  try {
    await updateNote(note.id, { completed: true })
    await loadNotes()
    await refreshReminders()
    setStatus('备忘录已完成')
  } catch (error) {
    setStatus(`状态更新失败：${error.message || '请稍后重试'}`, 'error')
  }
}

function handleCommandAction(event) {
  const action = event.detail?.action
  if (action === 'view-due-reminders') {
    void openReminderCenter()
    return
  }

  if (!['create-memo', 'create-diary'].includes(action)) return

  createMenuOpen.value = false
  handleCreateNote(action === 'create-diary' ? 'diary' : 'memo')
}

// 初始化
onMounted(async () => {
  window.addEventListener(COMMAND_ACTION_EVENT, handleCommandAction)
  document.addEventListener('pointerdown', handleCreateMenuPointerDown)
  window.addEventListener('keydown', handleCreateMenuKeydown)

  await loadNotes()
  await refreshReminders()

  const requestedSearch = Array.isArray(route.query.search)
    ? route.query.search[0]
    : route.query.search
  const requestedNoteId = Array.isArray(route.query.note)
    ? route.query.note[0]
    : route.query.note

  if (requestedSearch) {
    searchQuery.value = String(requestedSearch)
    filterType.value = 'all'
    memoStatus.value = 'all'
  }

  if (requestedNoteId) {
    const requestedNote = notes.value.find((note) => String(note.id) === String(requestedNoteId))
    if (requestedNote && !requestedNote.encrypted) {
      handlePreviewNote(requestedNote)
    }
  }

  // 加载时光模块背景图
  const bg = await getSetting('whisperBgImage')
  if (bg) whisperBgImage.value = bg
})

onBeforeUnmount(() => {
  window.removeEventListener(COMMAND_ACTION_EVENT, handleCommandAction)
  document.removeEventListener('pointerdown', handleCreateMenuPointerDown)
  window.removeEventListener('keydown', handleCreateMenuKeydown)
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
          <h1 class="header__title" aria-label="日记与备忘录">
            <span class="header__title-full" aria-hidden="true">日记与备忘录</span>
            <span class="header__title-compact" aria-hidden="true">时光</span>
          </h1>
        </div>
      </div>
      <div class="header__actions">
        <button class="header__btn" type="button" aria-label="打开图片库" title="图片库" @click="goToMedia">
          <Icon name="image" :size="18" />
        </button>
        <button
          ref="reminderButtonRef"
          class="header__btn reminder-button"
          type="button"
          :aria-label="reminderUnreadCount ? `打开到期提醒，${reminderUnreadCount} 条未读` : '打开到期提醒'"
          title="到期提醒"
          @click="openReminderCenter"
        >
          <Icon name="clock" :size="18" />
          <span
            v-if="reminderUnreadCount"
            class="reminder-button__badge"
            aria-hidden="true"
          >
            {{ reminderUnreadCount > 99 ? '99+' : reminderUnreadCount }}
          </span>
        </button>
        <button class="header__btn" type="button" aria-label="打开页面设置" title="设置" @click="showSettings = true">
          <Icon name="settings" :size="18" />
        </button>
        <div ref="createMenuRef" class="create-menu">
          <button
            ref="createMenuButtonRef"
            class="btn btn--primary"
            type="button"
            aria-label="新建记录"
            aria-haspopup="menu"
            :aria-expanded="createMenuOpen"
            aria-controls="note-create-menu"
            @click="toggleCreateMenu"
          >
            <Icon name="plus" :size="17" />
            <span class="create-menu__label">新建</span>
            <Icon class="create-menu__chevron" name="chevron-down" :size="14" />
          </button>
          <Transition name="create-menu">
            <div
              v-if="createMenuOpen"
              id="note-create-menu"
              class="create-menu__panel"
              role="menu"
              aria-label="新建记录"
              @keydown="handleCreateMenuNavigation"
            >
              <button type="button" role="menuitem" @click="chooseCreateNote('memo')">
                <span class="create-menu__icon"><Icon name="list" :size="18" /></span>
                <span>
                  <strong>备忘录</strong>
                  <small>记录任务、资料和灵感</small>
                </span>
              </button>
              <button type="button" role="menuitem" @click="chooseCreateNote('diary')">
                <span class="create-menu__icon"><Icon name="book" :size="18" /></span>
                <span>
                  <strong>日记</strong>
                  <small>记录今天发生的事情</small>
                </span>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="main">
      <section v-if="notes.length > 0" class="overview-strip" aria-label="记录概览">
        <div><strong>{{ noteStats.openMemos }}</strong><span>待办备忘</span></div>
        <div><strong>{{ noteStats.completedMemos }}</strong><span>已完成</span></div>
        <div><strong>{{ noteStats.diaries }}</strong><span>日记</span></div>
      </section>

      <div class="notes-toolbar">
        <label class="notes-search">
          <Icon name="search" :size="18" />
          <input
            v-model="searchQuery"
            type="search"
            aria-label="搜索标题、正文或标签"
            placeholder="搜索标题、正文或标签"
          >
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
          <button class="btn btn--primary" type="button" @click="toggleCreateMenu">
            <Icon name="plus" :size="17" /> 新建第一条记录
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
              @ai="handleAiNote"
              @copy-id="handleCopyNoteId"
              @copy-extract="handleCopyNoteExtract"
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
                @ai="handleAiNote"
                @copy-id="handleCopyNoteId"
                @copy-extract="handleCopyNoteExtract"
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
              @ai="handleAiNote"
              @copy-id="handleCopyNoteId"
              @copy-extract="handleCopyNoteExtract"
              @delete="handleDeleteNote"
              @togglePin="handleTogglePin"
              @toggleComplete="handleToggleComplete"
              @share="handleShareNote"
            />
          </div>
        </section>
      </div>
    </main>

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
      :return-focus="previewReturnFocus"
      @close="showPreview = false; previewingNote = null; previewReturnFocus = null"
      @edit="showPreview = false; previewingNote = null; previewReturnFocus = null; handleEditNote($event)"
      @ai="handleAiNote"
      @copy-id="handleCopyNoteId"
      @copy-extract="handleCopyNoteExtract"
      @copy-value="handleCopyValue"
    />

    <!-- 分享管理弹窗 -->
    <ShareManager
      :show="showShareManager"
      :note="sharingNote"
      @close="showShareManager = false; sharingNote = null"
      @shared="loadNotes"
      @cancelled="loadNotes"
    />

    <ReminderCenter
      :show="showReminderCenter"
      :reminders="reminders"
      :unread-count="reminderUnreadCount"
      :loading="remindersLoading"
      :error="remindersError"
      :local-only="remindersLocalOnly"
      @close="showReminderCenter = false"
      @refresh="refreshReminders"
      @read="handleReminderRead"
      @read-all="handleAllRemindersRead"
      @view="handleReminderView"
      @complete="handleReminderComplete"
    />

    <!-- 设置弹窗 -->
    <Modal
      :show="showSettings"
      title="页面设置"
      width="420px"
      initial-focus-selector=".upload-btn"
      @close="showSettings = false"
    >
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
              <label
                class="upload-btn"
                role="button"
                tabindex="0"
                @keydown.enter.prevent="$event.currentTarget.querySelector('input').click()"
                @keydown.space.prevent="$event.currentTarget.querySelector('input').click()"
              >
                {{ whisperBgImage ? '更换' : '上传图片' }}
                <input type="file" accept="image/*" hidden @change="handleBgUpload">
              </label>
            </div>
          </div>
        </div>
      </div>
    </Modal>

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

.header__title-compact {
  display: none;
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
  width: 44px;
  height: 44px;
  font-size: 16px;
}

.reminder-button {
  position: relative;
}

.reminder-button__badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  background: var(--error-color);
  border: 2px solid var(--bg-primary);
  border-radius: 999px;
}

.create-menu {
  position: relative;
}

.create-menu .btn--primary {
  min-height: 44px;
}

.create-menu__chevron {
  transition: transform var(--transition-fast);
}

.create-menu .btn--primary[aria-expanded='true'] .create-menu__chevron {
  transform: rotate(180deg);
}

.create-menu__panel {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 120;
  width: min(280px, calc(100vw - 32px));
  padding: 7px;
  background: color-mix(in srgb, var(--bg-card) 96%, transparent);
  border: 1px solid var(--border-light);
  border-radius: 18px;
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px);
}

.create-menu__panel button {
  width: 100%;
  min-height: 62px;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 11px;
  padding: 9px 10px;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  border-radius: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.create-menu__panel button:hover,
.create-menu__panel button:focus-visible {
  background: var(--bg-hover);
}

.create-menu__panel button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: -2px;
}

.create-menu__panel button > span:last-child {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.create-menu__panel strong {
  font-size: 14px;
  font-weight: 650;
}

.create-menu__panel small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.create-menu__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 12px;
}

.create-menu-enter-active,
.create-menu-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
  transform-origin: top right;
}

.create-menu-enter-from,
.create-menu-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.98);
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

.settings-modal__body {
  padding: 0;
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
  top: 0;
  right: 0;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 10px;
  cursor: pointer;
}

.bg-clear::before {
  position: absolute;
  width: 22px;
  height: 22px;
  content: '';
  background: var(--error-color);
  border-radius: 50%;
}

.bg-clear :deep(svg) {
  position: relative;
  z-index: 1;
}

.upload-btn {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
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

.upload-btn:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 1600;
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
    gap: 8px;
    padding: 8px 12px;
  }

  .header__left {
    min-width: 0;
  }

  .header__title {
    font-size: 17px;
  }

  .header__actions .header__btn {
    width: 44px;
    height: 44px;
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

}

@media (max-width: 420px) {
  .header__left {
    gap: 6px;
  }

  .header__eyebrow,
  .header__title-full,
  .create-menu__label,
  .create-menu__chevron {
    display: none;
  }

  .header__title-compact {
    display: inline;
  }

  .header__actions {
    gap: 6px;
  }

  .header__actions .btn--primary {
    width: 44px;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .create-menu__chevron,
  .create-menu-enter-active,
  .create-menu-leave-active {
    transition: none;
  }
}
</style>
