<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'

let modalSequence = 0

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: ''
  },
  width: {
    type: String,
    default: '480px'
  },
  initialFocusSelector: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['close'])
const dialog = ref(null)
const closeButton = ref(null)
const titleId = `modal-title-${++modalSequence}`
let returnFocusElement = null
let previousBodyOverflow = ''
let modalIsActive = false

const focusableSelector = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[contenteditable="true"]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function close() {
  emit('close')
}

function onOverlayClick(e) {
  if (e.target === e.currentTarget) {
    close()
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
  }
}

function getFocusableElements() {
  return Array.from(dialog.value?.querySelectorAll(focusableSelector) || [])
    .filter((element) => (
      !element.hasAttribute('hidden')
      && element.getAttribute('aria-hidden') !== 'true'
      && element.getClientRects().length > 0
    ))
}

function trapFocus(event) {
  const focusable = getFocusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]

  if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault()
    first.focus()
  }
}

function restoreFocus() {
  const target = returnFocusElement
  returnFocusElement = null
  if (target?.isConnected && typeof target.focus === 'function') {
    target.focus()
  }
}

async function focusInitialElement() {
  await nextTick()
  const requested = props.initialFocusSelector
    ? dialog.value?.querySelector(props.initialFocusSelector)
    : null
  const target = requested
    || dialog.value?.querySelector('[data-modal-initial-focus], [autofocus]')
    || getFocusableElements().find((element) => element !== closeButton.value)
    || closeButton.value
    || dialog.value
  target?.focus()
}

watch(() => props.show, async (val, previousValue) => {
  if (val) {
    modalIsActive = true
    returnFocusElement = document.activeElement
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    await focusInitialElement()
  } else if (previousValue && modalIsActive) {
    modalIsActive = false
    document.body.style.overflow = previousBodyOverflow
    document.removeEventListener('keydown', onKeyDown)
    await nextTick()
    restoreFocus()
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (modalIsActive) {
    document.body.style.overflow = previousBodyOverflow
  }
  document.removeEventListener('keydown', onKeyDown)
  if (modalIsActive) restoreFocus()
  modalIsActive = false
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay" @click="onOverlayClick">
        <div
          ref="dialog"
          class="modal-content"
          :style="{ maxWidth: width }"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          :aria-label="title ? undefined : '对话框'"
          tabindex="-1"
          @keydown.tab="trapFocus"
        >
          <div class="modal__header">
            <h2 :id="titleId" class="modal__title">{{ title }}</h2>
            <button ref="closeButton" type="button" class="modal__close" aria-label="关闭弹窗" @click="close">
              <Icon name="close" :size="18" />
            </button>
          </div>
          <div class="modal__body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="modal__footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-content {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-light);
}

.modal__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal__close {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.modal__close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.modal__body {
  padding: 24px;
}

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-light);
}

/* 表单样式 */
:deep(.form-group) {
  margin-bottom: 16px;
}

:deep(.form-label) {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

:deep(.input) {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

:deep(.input:focus) {
  outline: none;
  border-color: var(--accent-color);
  background: var(--bg-primary);
}

:deep(.input::placeholder) {
  color: var(--text-muted);
}

:deep(textarea.input) {
  resize: vertical;
  min-height: 80px;
}

:deep(select.input) {
  cursor: pointer;
}

/* Modal 动画 */
.modal-enter-active {
  animation: fadeIn 0.2s ease;
}

.modal-enter-active .modal-content {
  animation: scaleIn 0.25s var(--ease-bounce);
}

.modal-leave-active {
  animation: fadeOut 0.15s ease;
}

.modal-leave-active .modal-content {
  animation: scaleIn 0.15s ease reverse;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes fadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
