<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import {
  fetchBackendNoteVersions,
  restoreBackendNoteVersion,
  shouldUseBackendNotes
} from '@/shared/services/notesApi'

const props = defineProps({
  show: { type: Boolean, default: false },
  note: { type: Object, default: null }
})
const emit = defineEmits(['close', 'restored'])
const versions = ref([])
const selectedId = ref('')
const loading = ref(false)
const restoring = ref(false)
const error = ref('')

const selected = computed(() => versions.value.find((item) => item.id === selectedId.value) || null)

function formatDate(value) {
  const date = new Date(value || '')
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}

async function loadVersions() {
  versions.value = []
  selectedId.value = ''
  error.value = ''
  if (!props.note?.id) return
  if (!shouldUseBackendNotes()) {
    error.value = '本地浏览器模式暂不保存版本历史；连接 NAV 服务端后可使用。'
    return
  }
  loading.value = true
  try {
    const payload = await fetchBackendNoteVersions(props.note.id)
    versions.value = payload.versions
    selectedId.value = versions.value[0]?.id || ''
  } catch (loadError) {
    error.value = loadError.message || '版本历史加载失败'
  } finally {
    loading.value = false
  }
}

async function restoreSelected() {
  if (!selected.value || restoring.value) return
  if (!confirm(`恢复到版本 ${selected.value.revision}？当前内容会先自动保留为新版本。`)) return
  restoring.value = true
  error.value = ''
  try {
    const note = await restoreBackendNoteVersion(props.note.id, selected.value.id)
    emit('restored', note)
  } catch (restoreError) {
    error.value = restoreError.message || '版本恢复失败'
  } finally {
    restoring.value = false
  }
}

watch(() => props.show, (show) => {
  if (show) void loadVersions()
})
</script>

<template>
  <Modal
    :show="show"
    :title="`版本历史 · ${note?.title || '笔记'}`"
    width="760px"
    :close-disabled="restoring"
    @close="emit('close')"
  >
    <p class="version-history__notice">
      每次保存前会保留旧内容，单条笔记最多 50 个版本。图片附件不进入版本快照；恢复时保留当前图片。
    </p>
    <p v-if="error" class="version-history__error" role="alert">{{ error }}</p>
    <div v-if="loading" class="version-history__empty" role="status">正在加载版本历史</div>
    <div v-else-if="versions.length" class="version-history__layout">
      <ol class="version-history__list" aria-label="历史版本">
        <li v-for="version in versions" :key="version.id">
          <button
            type="button"
            :class="{ 'is-active': selectedId === version.id }"
            @click="selectedId = version.id"
          >
            <Icon name="clock" :size="16" />
            <span>版本 {{ version.revision }}</span>
            <small>{{ formatDate(version.createdAt) }}</small>
          </button>
        </li>
      </ol>
      <article v-if="selected" class="version-history__preview" aria-live="polite">
        <h3>{{ selected.title }}</h3>
        <p v-if="selected.encrypted" class="version-history__locked">
          <Icon name="lock" :size="17" /> 加密版本的正文不会发送到浏览器，可直接恢复后再用原密码解锁。
        </p>
        <pre v-else>{{ selected.content || '此版本没有正文' }}</pre>
      </article>
    </div>
    <div v-else-if="!error" class="version-history__empty">保存一次修改后，历史版本会显示在这里。</div>

    <template #footer>
      <button type="button" class="btn btn--secondary" :disabled="restoring" @click="emit('close')">关闭</button>
      <button type="button" class="btn btn--primary" :disabled="!selected || restoring" @click="restoreSelected">
        {{ restoring ? '恢复中' : '恢复此版本' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.version-history__notice,
.version-history__error,
.version-history__empty {
  margin: 0 0 16px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.65;
}
.version-history__error { color: var(--error-color); }
.version-history__layout { display: grid; grid-template-columns: minmax(190px, 0.7fr) minmax(0, 1.3fr); gap: 16px; }
.version-history__list { display: grid; align-content: start; gap: 7px; margin: 0; padding: 0; list-style: none; }
.version-history__list button { width: 100%; min-height: 52px; display: grid; grid-template-columns: 20px 1fr; gap: 2px 8px; padding: 9px 11px; color: var(--text-secondary); text-align: left; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.version-history__list button.is-active { color: var(--accent-color); border-color: var(--accent-color); background: var(--accent-bg); }
.version-history__list small { grid-column: 2; color: var(--text-muted); }
.version-history__preview { min-height: 240px; padding: 18px; overflow: auto; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 14px; }
.version-history__preview h3 { margin: 0 0 14px; color: var(--text-primary); }
.version-history__preview pre { margin: 0; color: var(--text-secondary); font: inherit; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.version-history__locked { display: flex; gap: 8px; color: var(--text-muted); line-height: 1.65; }
.btn { min-height: 44px; padding: 10px 18px; border: 0; border-radius: 13px; font: inherit; cursor: pointer; }
.btn--secondary { color: var(--text-primary); background: var(--bg-secondary); }
.btn--primary { color: #fff; background: var(--accent-color); }
.btn:disabled { cursor: not-allowed; opacity: 0.55; }
@media (max-width: 640px) { .version-history__layout { grid-template-columns: 1fr; } .version-history__list { max-height: 190px; overflow-y: auto; } }
</style>
