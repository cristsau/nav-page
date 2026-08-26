<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import MailFolderSidebar from './MailFolderSidebar.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  accounts: { type: Array, default: () => [] },
  folders: { type: Array, default: () => [] },
  activeAccountId: { type: String, default: '' },
  activeFolderId: { type: String, default: '' },
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'select-account', 'select-folder'])
const dialog = ref(null)
let restoreTarget = null

function focusableElements() {
  return [...(dialog.value?.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
}

function requestClose() {
  emit('close')
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
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
    restoreTarget = document.activeElement
    await nextTick()
    focusableElements()[0]?.focus()
  } else {
    restoreTarget?.focus?.()
    restoreTarget = null
  }
})

onBeforeUnmount(() => restoreTarget?.focus?.())
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mail-folder-sheet" @mousedown.self="requestClose">
      <section
        ref="dialog"
        class="mail-folder-sheet__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-folder-sheet-title"
        @keydown="onKeydown"
      >
        <header>
          <div>
            <p>邮箱导航</p>
            <h2 id="mail-folder-sheet-title">选择文件夹</h2>
          </div>
          <button type="button" aria-label="关闭文件夹选择" @click="requestClose">
            <Icon name="close" :size="19" />
          </button>
        </header>
        <MailFolderSidebar
          title-id="mail-folder-sheet-sidebar-title"
          :accounts="accounts"
          :folders="folders"
          :active-account-id="activeAccountId"
          :active-folder-id="activeFolderId"
          :loading="loading"
          @select-account="emit('select-account', $event)"
          @select-folder="emit('select-folder', $event)"
        />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mail-folder-sheet { position: fixed; z-index: 1200; inset: 0; display: flex; padding: 18px 12px max(12px, env(safe-area-inset-bottom)); align-items: flex-end; justify-content: center; background: color-mix(in srgb, #000 52%, transparent); }
.mail-folder-sheet__dialog { width: min(100%, 520px); max-height: min(82vh, 720px); overflow-y: auto; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 22px; box-shadow: var(--shadow-modal, 0 22px 80px rgb(0 0 0 / .28)); }
.mail-folder-sheet__dialog > header { position: sticky; top: 0; z-index: 2; display: flex; min-height: 70px; padding: 12px 14px; align-items: center; justify-content: space-between; gap: 12px; background: color-mix(in srgb, var(--bg-secondary) 96%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(14px); }
.mail-folder-sheet__dialog header p { margin: 0 0 3px; color: var(--accent-color); font-size: .62rem; font-weight: 730; }
.mail-folder-sheet__dialog header h2 { margin: 0; font-size: .9rem; }
.mail-folder-sheet__dialog header button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
@media (min-width: 821px) and (hover: hover) {
  .mail-folder-sheet { display: none; }
}
</style>
