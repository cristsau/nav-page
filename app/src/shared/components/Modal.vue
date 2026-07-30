<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'

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
  }
})

const emit = defineEmits(['close'])
const closeButton = ref(null)

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
    close()
  }
}

watch(() => props.show, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)
    nextTick(() => closeButton.value?.focus())
  } else {
    document.body.style.overflow = ''
    document.removeEventListener('keydown', onKeyDown)
  }
})

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay" @click="onOverlayClick">
        <div
          class="modal-content"
          :style="{ maxWidth: width }"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <div class="modal__header">
            <h3 class="modal__title">{{ title }}</h3>
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
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal__close {
  width: 32px;
  height: 32px;
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
