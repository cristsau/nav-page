<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: 'move' },
  folders: { type: Array, default: () => [] },
  currentFolderId: { type: String, default: '' },
  subject: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  restoreTarget: { type: Object, default: null }
})

const emit = defineEmits(['close', 'confirm'])
const panel = ref(null)
const firstControl = ref(null)
const selectedFolderId = ref('')
const deleteConfirmation = ref('')

const moveFolders = computed(() => props.folders.filter((folder) => (
  folder
  && folder.selectable !== false
  && String(folder.id || '') !== String(props.currentFolderId || '')
)))
const isDelete = computed(() => props.mode === 'delete')
const canSubmit = computed(() => (
  !props.busy
  && (isDelete.value
    ? deleteConfirmation.value.trim().toUpperCase() === 'DELETE'
    : Boolean(selectedFolderId.value))
))

function close() {
  if (!props.busy) emit('close')
}

function submit() {
  if (!canSubmit.value) return
  emit('confirm', isDelete.value
    ? { confirm: 'DELETE_PERMANENTLY' }
    : { targetFolderId: selectedFolderId.value })
}

function focusableElements() {
  return Array.from(panel.value?.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ) || [])
}

function onKeydown(event) {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const elements = focusableElements()
  if (!elements.length) return
  const first = elements[0]
  const last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  if (open) {
    selectedFolderId.value = moveFolders.value[0]?.id || ''
    deleteConfirmation.value = ''
    await nextTick()
    firstControl.value?.focus?.()
  } else {
    props.restoreTarget?.focus?.({ preventScroll: true })
  }
})

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mail-action-dialog" @mousedown.self="close">
      <section
        ref="panel"
        class="mail-action-dialog__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="isDelete ? 'mail-delete-dialog-title' : 'mail-move-dialog-title'"
      >
        <header>
          <div>
            <span><Icon :name="isDelete ? 'trash' : 'folder'" :size="19" /></span>
            <div>
              <p>{{ isDelete ? '不可恢复的操作' : '移动邮件' }}</p>
              <h2 :id="isDelete ? 'mail-delete-dialog-title' : 'mail-move-dialog-title'">
                {{ isDelete ? '永久删除邮件' : '选择目标文件夹' }}
              </h2>
            </div>
          </div>
          <button type="button" aria-label="关闭" :disabled="busy" @click="close"><Icon name="close" :size="18" /></button>
        </header>

        <div class="mail-action-dialog__body">
          <p class="mail-action-dialog__subject">{{ subject || '(无主题)' }}</p>
          <template v-if="isDelete">
            <p>邮件会从远端邮箱永久删除，不能通过 DOMO NAV 撤销。请只在垃圾箱中执行。</p>
            <label>
              <span>输入 DELETE 确认</span>
              <input ref="firstControl" v-model="deleteConfirmation" type="text" autocomplete="off" spellcheck="false">
            </label>
          </template>
          <template v-else>
            <label>
              <span>目标文件夹</span>
              <select ref="firstControl" v-model="selectedFolderId">
                <option v-for="folder in moveFolders" :key="folder.id" :value="folder.id">
                  {{ folder.name || folder.path || '未命名文件夹' }}
                </option>
              </select>
            </label>
            <p v-if="!moveFolders.length" class="mail-action-dialog__warning" role="alert">没有可移动到的其他文件夹。</p>
            <p>提交后先进入安全队列；若远端状态已变化，操作会以冲突结束，不会覆盖新状态。</p>
          </template>
        </div>

        <footer>
          <button type="button" :disabled="busy" @click="close">取消</button>
          <button type="button" :class="{ 'is-danger': isDelete }" :disabled="!canSubmit" @click="submit">
            <Icon :name="isDelete ? 'trash' : 'folder'" :size="17" />
            {{ busy ? '正在提交…' : isDelete ? '永久删除' : '确认移动' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mail-action-dialog { position: fixed; z-index: 900; inset: 0; display: grid; padding: 18px; place-items: center; background: rgb(7 8 12 / .58); backdrop-filter: blur(10px); }
.mail-action-dialog__panel { width: min(480px, 100%); max-height: min(720px, calc(100dvh - 36px)); overflow: auto; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 24px; box-shadow: 0 24px 80px rgb(0 0 0 / .24); }
.mail-action-dialog__panel > header { position: sticky; top: 0; z-index: 2; display: flex; min-height: 80px; padding: 16px 18px; align-items: center; justify-content: space-between; gap: 14px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(16px); }
.mail-action-dialog__panel > header > div { display: flex; min-width: 0; align-items: center; gap: 12px; }
.mail-action-dialog__panel > header > div > span { display: grid; width: 42px; height: 42px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 13px; }
.mail-action-dialog__panel header p { margin: 0 0 3px; color: var(--text-muted); font-size: .66rem; }
.mail-action-dialog__panel h2 { margin: 0; font-size: 1.05rem; }
.mail-action-dialog__panel header button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; cursor: pointer; }
.mail-action-dialog__body { display: grid; padding: 20px; gap: 16px; }
.mail-action-dialog__body > p { margin: 0; color: var(--text-muted); font-size: .75rem; line-height: 1.65; }
.mail-action-dialog__subject { padding: 12px 14px; color: var(--text-primary) !important; font-weight: 720; background: var(--bg-secondary); border-radius: 13px; }
.mail-action-dialog__body label { display: grid; gap: 7px; color: var(--text-secondary); font-size: .72rem; font-weight: 700; }
.mail-action-dialog__body input,
.mail-action-dialog__body select { width: 100%; min-height: 48px; padding: 0 13px; color: var(--text-primary); font: inherit; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; }
.mail-action-dialog__warning { color: var(--danger-color, #b84b55) !important; }
.mail-action-dialog__panel > footer { position: sticky; bottom: 0; display: flex; padding: 14px 18px calc(14px + env(safe-area-inset-bottom)); justify-content: flex-end; gap: 9px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border-top: 1px solid var(--border-light); backdrop-filter: blur(16px); }
.mail-action-dialog__panel > footer button { display: inline-flex; min-height: 44px; padding: 0 17px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); font: inherit; font-size: .75rem; font-weight: 720; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; cursor: pointer; }
.mail-action-dialog__panel > footer button:last-child { color: var(--accent-text, white); background: var(--accent-color); border-color: var(--accent-color); }
.mail-action-dialog__panel > footer button.is-danger { color: white; background: var(--danger-color, #b84b55); border-color: var(--danger-color, #b84b55); }
.mail-action-dialog__panel button:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 640px) {
  .mail-action-dialog { padding: 0; align-items: end; }
  .mail-action-dialog__panel { width: 100%; max-height: 86dvh; border-radius: 24px 24px 0 0; }
}
</style>
