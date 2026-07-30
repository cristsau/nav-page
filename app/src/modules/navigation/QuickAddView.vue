<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '@/shared/composables/useAuth'
import { useBookmarks, useGroups } from '@/shared/composables/useDB'
import Icon from '@/shared/components/Icon.vue'

const DEFAULT_GROUP_NAME = '默认分组'

const route = useRoute()
const router = useRouter()
const { initAuth } = useAuth()
const groupStore = useGroups()
const bookmarkStore = useBookmarks()

const form = ref({
  title: '',
  url: '',
  favicon: '',
  description: '',
  groupId: ''
})
const newGroupName = ref('')
const saving = ref(false)
const creatingGroup = ref(false)
const statusMessage = ref('')
const statusType = ref('')

const groups = computed(() => groupStore.groups.value || [])
const bookmarks = computed(() => bookmarkStore.bookmarks.value || [])

function normalizeWebUrl(value) {
  const input = String(value || '').trim()
  if (!input) return ''

  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`

  try {
    const parsed = new URL(withProtocol)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function syncFromQuery() {
  form.value.title = String(route.query.title || '')
  form.value.url = String(route.query.url || '')
  form.value.favicon = String(route.query.favicon || '')
}

watch(() => route.query, syncFromQuery, { immediate: true })

onMounted(async () => {
  await initAuth()
  await Promise.all([groupStore.load(), bookmarkStore.load()])

  if (groups.value.length > 0 && !form.value.groupId) {
    form.value.groupId = groups.value[0].id
  }
})

async function ensureDefaultGroup() {
  if (groups.value.length > 0) {
    return groups.value.find((group) => group.name === DEFAULT_GROUP_NAME) || groups.value[0]
  }

  return groupStore.create({
    name: DEFAULT_GROUP_NAME,
    icon: 'folder',
    color: '#a08060'
  })
}

async function handleCreateGroup() {
  const name = newGroupName.value.trim()
  if (!name || creatingGroup.value) return

  creatingGroup.value = true
  setStatus('', '')

  try {
    const group = await groupStore.create({
      name,
      icon: 'folder',
      color: '#a08060'
    })

    newGroupName.value = ''
    form.value.groupId = group.id
    setStatus('分组创建成功', 'success')
  } catch (error) {
    setStatus(error.message || '创建分组失败', 'error')
  } finally {
    creatingGroup.value = false
  }
}

async function handleSave() {
  const title = form.value.title.trim()
  const url = normalizeWebUrl(form.value.url)

  if (!title || !form.value.url.trim() || saving.value) {
    setStatus('请先填写标题和网址', 'error')
    return
  }

  if (!url) {
    setStatus('仅支持有效的 http 或 https 网页地址', 'error')
    return
  }

  saving.value = true
  setStatus('', '')

  try {
    let groupId = form.value.groupId

    if (!groupId) {
      const group = await ensureDefaultGroup()
      groupId = group.id
      form.value.groupId = groupId
    }

    const duplicate = bookmarks.value.find((bookmark) => (
      bookmark.groupId === groupId &&
      normalizeWebUrl(bookmark.url).toLowerCase() === url.toLowerCase()
    ))

    if (duplicate) {
      setStatus('该网页已在这个分组中，没有重复添加', 'success')
      return
    }

    await bookmarkStore.create({
      groupId,
      title,
      url,
      favicon: form.value.favicon,
      description: form.value.description.trim(),
      deduplicate: true
    })

    setStatus('已成功添加到 DOMO NAV', 'success')
  } catch (error) {
    setStatus(error.message || '添加失败', 'error')
  } finally {
    saving.value = false
  }
}

function setStatus(message, type) {
  statusMessage.value = message
  statusType.value = type
}

function goHome() {
  router.push('/')
}
</script>

<template>
  <div class="page">
    <main class="panel">
      <div class="panel__header">
        <div>
          <h1><Icon name="browser" :size="24" /> 快速添加到 DOMO NAV</h1>
          <p>适合浏览器扩展、右键菜单、iPhone 快捷指令和手动快速收藏使用。</p>
        </div>
        <button class="ghost-btn" type="button" @click="goHome">返回首页</button>
      </div>

      <div class="form-grid">
        <label class="field">
          <span>标题</span>
          <input v-model="form.title" type="text" placeholder="当前网页标题">
        </label>

        <label class="field">
          <span>网址</span>
          <input v-model="form.url" type="url" placeholder="https://example.com">
        </label>

        <label class="field">
          <span>分组</span>
          <select v-model="form.groupId">
            <option value="">默认分组（无分组时自动创建）</option>
            <option v-for="group in groups" :key="group.id" :value="group.id">
              {{ group.name }}
            </option>
          </select>
        </label>

        <div class="field">
          <span>快速创建分组</span>
          <div class="inline-row">
            <input v-model="newGroupName" type="text" placeholder="输入新分组名">
            <button type="button" class="secondary-btn" :disabled="creatingGroup" @click="handleCreateGroup">
              {{ creatingGroup ? '创建中...' : '创建' }}
            </button>
          </div>
        </div>

        <label class="field field--full">
          <span>备注</span>
          <textarea v-model="form.description" rows="4" placeholder="给这个书签补一条备注"></textarea>
        </label>
      </div>

      <div v-if="statusMessage" class="status" :class="`is-${statusType}`" role="status" aria-live="polite">
        {{ statusMessage }}
      </div>

      <div class="actions">
        <button class="secondary-btn" type="button" @click="goHome">稍后再说</button>
        <button class="primary-btn" type="button" :disabled="saving" @click="handleSave">
          {{ saving ? '保存中...' : '添加到 DOMO NAV' }}
        </button>
      </div>

      <p class="signature">Design by CrisTsau</p>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 32px 16px;
  background:
    radial-gradient(circle at top left, color-mix(in srgb, var(--accent-color) 16%, transparent), transparent 32%),
    var(--bg-primary);
}

.panel {
  width: min(100%, 760px);
  margin: 0 auto;
  padding: 28px;
  background: var(--bg-card);
  border-radius: 32px;
  box-shadow: var(--shadow-card-hover);
}

.panel__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.panel__header h1 {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  color: var(--text-primary);
}

.panel__header p {
  margin: 8px 0 0;
  color: var(--text-muted);
  line-height: 1.7;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: grid;
  gap: 8px;
}

.field--full {
  grid-column: 1 / -1;
}

.field span {
  color: var(--text-secondary);
  font-size: 13px;
}

input,
select,
textarea {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  outline: none;
}

textarea {
  resize: vertical;
}

.inline-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

.primary-btn,
.secondary-btn,
.ghost-btn {
  padding: 12px 18px;
  border: none;
  border-radius: 16px;
  cursor: pointer;
}

.primary-btn {
  background: var(--accent-color);
  color: #fff;
}

.secondary-btn,
.ghost-btn {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.status {
  margin-top: 16px;
  padding: 14px 16px;
  border-radius: 16px;
  background: var(--bg-secondary);
}

.status.is-success {
  color: #3f7a56;
}

.status.is-error {
  color: #c84d4d;
}

.signature {
  margin: 18px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
}

@media (max-width: 720px) {
  .panel {
    padding: 22px;
  }

  .panel__header,
  .form-grid {
    grid-template-columns: 1fr;
    display: grid;
  }

  .actions {
    flex-direction: column;
  }
}
</style>
