<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  addBookmark as addLocalBookmark,
  addGroup as addLocalGroup,
  addNote as addLocalNote,
  getAllBookmarks as getLocalBookmarks,
  getGroups as getLocalGroups,
  getNotes as getLocalNotes
} from '@/shared/db/database'
import {
  fetchBackendBookmarks,
  fetchBackendGroups,
  shouldUseBackendNavigation
} from '@/shared/services/navigationApi'
import {
  fetchBackendNotes,
  shouldUseBackendNotes
} from '@/shared/services/notesApi'
import {
  importBackendBookmarks,
  importBackendNotes
} from '@/shared/services/productivityImportsApi'
import {
  BOOKMARK_IMPORT_LIMIT,
  parseBookmarkHtml,
  planBookmarkImport
} from '@/shared/utils/bookmarkImport'
import {
  exportNotesToMarkdown,
  NOTE_MARKDOWN_IMPORT_LIMIT,
  parseNotesMarkdown
} from '@/shared/utils/noteMarkdown'

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024
const groups = ref([])
const bookmarks = ref([])
const bookmarkPreview = ref(null)
const bookmarkFileName = ref('')
const targetGroupId = ref('')
const preserveFolders = ref(true)
const notePreview = ref(null)
const noteFileName = ref('')
const busy = ref(false)
const status = ref({ text: '', type: '' })

const folderGroupIds = computed(() => Object.fromEntries(groups.value.map((group) => [
  String(group.name || '').toLocaleLowerCase('zh-CN'),
  group.id
])))
const bookmarkPlan = computed(() => planBookmarkImport(bookmarkPreview.value?.entries || [], {
  targetGroupId: targetGroupId.value,
  preserveFolders: preserveFolders.value,
  existingBookmarks: bookmarks.value,
  folderGroupIds: folderGroupIds.value
}))

function setStatus(text, type = 'success') {
  status.value = { text, type }
}

async function loadNavigationData() {
  const backend = shouldUseBackendNavigation()
  const [nextGroups, nextBookmarks] = await Promise.all([
    backend ? fetchBackendGroups() : getLocalGroups(),
    backend ? fetchBackendBookmarks() : getLocalBookmarks()
  ])
  groups.value = nextGroups
  bookmarks.value = nextBookmarks
  if (!groups.value.some((group) => group.id === targetGroupId.value)) {
    targetGroupId.value = groups.value[0]?.id || ''
  }
}

async function readBoundedFile(file) {
  if (!file) return ''
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('导入文件不能超过 5 MB')
  return file.text()
}

async function previewBookmarkFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    bookmarkPreview.value = parseBookmarkHtml(await readBoundedFile(file), {
      maxEntries: BOOKMARK_IMPORT_LIMIT
    })
    bookmarkFileName.value = file.name
    setStatus(`已预览 ${bookmarkPreview.value.entries.length} 个可用链接`)
  } catch (error) {
    bookmarkPreview.value = null
    setStatus(`书签文件读取失败：${error.message}`, 'error')
  }
}

async function createGroup(name) {
  const payload = { name, icon: String(name || '导').slice(0, 1), color: '#667eea' }
  return addLocalGroup(payload)
}

async function createBookmark(bookmark) {
  const payload = { ...bookmark, deduplicate: true, tags: [] }
  return addLocalBookmark(payload)
}

async function importBookmarks() {
  if (!bookmarkPlan.value.planned.length || busy.value) return
  busy.value = true
  let imported = 0
  try {
    if (shouldUseBackendNavigation()) {
      const duplicateCount = bookmarkPlan.value.duplicates
      const result = await importBackendBookmarks(
        bookmarkPlan.value.planned.map((entry) => ({
          title: entry.title,
          url: entry.url,
          favicon: entry.favicon,
          description: entry.folderPath?.length
            ? `从 ${entry.folderPath.join(' / ')} 导入`
            : '',
          folderName: entry.folderName
        })),
        targetGroupId.value
      )
      imported = Number(result.createdCount || 0)
      await loadNavigationData()
      bookmarkPreview.value = null
      setStatus(`已导入 ${imported} 个书签；跳过 ${duplicateCount + Number(result.skippedDuplicates || 0)} 个重复项`)
      return
    }

    const groupByName = new Map(groups.value.map((group) => [
      String(group.name || '').toLocaleLowerCase('zh-CN'), group
    ]))
    let fallbackGroup = groups.value.find((group) => group.id === targetGroupId.value)
    if (!fallbackGroup) {
      fallbackGroup = await createGroup('导入书签')
      groups.value.push(fallbackGroup)
      targetGroupId.value = fallbackGroup.id
    }

    for (const entry of bookmarkPlan.value.planned) {
      let group = fallbackGroup
      if (entry.folderName) {
        const key = entry.folderName.toLocaleLowerCase('zh-CN')
        group = groupByName.get(key)
        if (!group) {
          group = await createGroup(entry.folderName)
          groupByName.set(key, group)
          groups.value.push(group)
        }
      }
      await createBookmark({
        groupId: group.id,
        title: entry.title,
        url: entry.url,
        favicon: entry.favicon,
        description: entry.folderPath?.length ? `从 ${entry.folderPath.join(' / ')} 导入` : ''
      })
      imported += 1
    }
    const duplicateCount = bookmarkPlan.value.duplicates
    await loadNavigationData()
    bookmarkPreview.value = null
    setStatus(`已导入 ${imported} 个书签；跳过 ${duplicateCount} 个重复项`)
  } catch (error) {
    await loadNavigationData().catch(() => {})
    setStatus(`导入在 ${imported} 项后中断：${error.message || '请稍后重试'}`, 'error')
  } finally {
    busy.value = false
  }
}

async function previewNoteFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    notePreview.value = parseNotesMarkdown(await readBoundedFile(file), {
      maxEntries: NOTE_MARKDOWN_IMPORT_LIMIT
    })
    noteFileName.value = file.name
    setStatus(`已预览 ${notePreview.value.notes.length} 条笔记`)
  } catch (error) {
    notePreview.value = null
    setStatus(`Markdown 读取失败：${error.message}`, 'error')
  }
}

async function importNotes() {
  if (!notePreview.value?.notes.length || busy.value) return
  busy.value = true
  let imported = 0
  try {
    if (shouldUseBackendNotes()) {
      const result = await importBackendNotes(notePreview.value.notes)
      imported = Number(result.createdCount || 0)
      notePreview.value = null
      setStatus(`已导入 ${imported} 条 Markdown 笔记`)
      return
    }

    for (const note of notePreview.value.notes) {
      await addLocalNote(note)
      imported += 1
    }
    notePreview.value = null
    setStatus(`已导入 ${imported} 条 Markdown 笔记`)
  } catch (error) {
    setStatus(`笔记导入在 ${imported} 条后中断：${error.message || '请稍后重试'}`, 'error')
  } finally {
    busy.value = false
  }
}

function downloadText(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function exportNotes() {
  if (busy.value) return
  busy.value = true
  try {
    const notes = shouldUseBackendNotes() ? await fetchBackendNotes() : await getLocalNotes()
    const result = exportNotesToMarkdown(notes)
    downloadText(
      result.markdown,
      `domo-nav-notes-${new Date().toISOString().slice(0, 10)}.md`,
      'text/markdown;charset=utf-8'
    )
    setStatus(`已导出 ${result.exported} 条；${result.skippedEncrypted} 条加密笔记未导出`)
  } catch (error) {
    setStatus(`Markdown 导出失败：${error.message || '请稍后重试'}`, 'error')
  } finally {
    busy.value = false
  }
}

onMounted(() => loadNavigationData().catch((error) => setStatus(error.message, 'error')))
</script>

<template>
  <section class="portability" aria-labelledby="portability-title">
    <div class="portability__heading">
      <div>
        <h4 id="portability-title">浏览器与 Markdown 迁移</h4>
        <p>先在浏览器内预览和去重，再写入当前账号；不会上传原始 HTML 或 Markdown 文件。</p>
      </div>
    </div>

    <div class="portability__grid">
      <article>
        <Icon name="browser" :size="21" />
        <h5>Chrome / Edge 书签 HTML</h5>
        <p>支持 Netscape 书签文件，最多 {{ BOOKMARK_IMPORT_LIMIT }} 项，可保留目录并映射为分组。</p>
        <label class="file-button">
          <input type="file" accept=".html,.htm,text/html" :disabled="busy" @change="previewBookmarkFile">
          选择 HTML 并预览
        </label>
        <div v-if="bookmarkPreview" class="portability__preview">
          <strong>{{ bookmarkFileName }}</strong>
          <span>可导入 {{ bookmarkPlan.planned.length }} · 重复 {{ bookmarkPlan.duplicates }} · 跳过 {{ bookmarkPreview.skipped }}</span>
          <label>
            <span>根目录书签目标分组</span>
            <select v-model="targetGroupId" :disabled="busy">
              <option value="">没有分组时自动创建“导入书签”</option>
              <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </label>
          <label class="check-label"><input v-model="preserveFolders" type="checkbox" :disabled="busy"> 保留目录并创建同名分组</label>
          <button type="button" :disabled="busy || !bookmarkPlan.planned.length" @click="importBookmarks">确认导入书签</button>
        </div>
      </article>

      <article>
        <Icon name="note" :size="21" />
        <h5>笔记 Markdown</h5>
        <p>最多 {{ NOTE_MARKDOWN_IMPORT_LIMIT }} 条；加密笔记不会进入明文导出，图片附件只保留在原笔记。</p>
        <div class="portability__actions">
          <label class="file-button">
            <input type="file" accept=".md,.markdown,text/markdown,text/plain" :disabled="busy" @change="previewNoteFile">
            选择 Markdown
          </label>
          <button type="button" :disabled="busy" @click="exportNotes">导出 Markdown</button>
        </div>
        <div v-if="notePreview" class="portability__preview">
          <strong>{{ noteFileName }}</strong>
          <span>可导入 {{ notePreview.notes.length }} · 跳过 {{ notePreview.skipped }}</span>
          <button type="button" :disabled="busy || !notePreview.notes.length" @click="importNotes">确认导入笔记</button>
        </div>
      </article>
    </div>
    <p v-if="status.text" class="portability__status" :class="`is-${status.type}`" role="status">{{ status.text }}</p>
  </section>
</template>

<style scoped>
.portability { margin: 18px 0; padding: 18px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 18px; }
.portability__heading h4,
.portability h5 { margin: 0; color: var(--text-primary); }
.portability__heading p,
.portability article > p { margin: 5px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.65; }
.portability__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.portability article { min-width: 0; padding: 16px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 15px; }
.portability article > svg { color: var(--accent-color); }
.portability h5 { margin-top: 8px; font-size: 14px; }
.portability button,
.file-button,
.portability select { min-height: 44px; padding: 9px 12px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; font: inherit; cursor: pointer; }
.file-button { display: inline-flex; align-items: center; justify-content: center; margin-top: 12px; }
.file-button input { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); }
.portability__actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.portability__preview { display: grid; gap: 9px; margin-top: 12px; padding: 12px; color: var(--text-secondary); background: var(--bg-secondary); border-radius: 12px; font-size: 12px; }
.portability__preview label:not(.check-label) { display: grid; gap: 5px; }
.check-label { display: flex; align-items: center; gap: 8px; min-height: 44px; }
.portability__status { margin: 12px 0 0; color: var(--success-color); font-size: 12px; }
.portability__status.is-error { color: var(--error-color); }
@media (max-width: 760px) { .portability__grid { grid-template-columns: 1fr; } }
</style>
