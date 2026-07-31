<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { decrypt } from '@/shared/utils/crypto'

const props = defineProps({
  note: {
    type: Object,
    required: true
  }
})

const emit = defineEmits([
  'preview',
  'edit',
  'delete',
  'togglePin',
  'toggleComplete',
  'share',
  'ai',
  'copyId',
  'copyExtract'
])

const showPasswordModal = ref(false)
const password = ref('')
const decryptedContent = ref(props.note._unlocked ? String(props.note.content || '') : '')
const decryptError = ref(false)
const unlockAction = ref('preview')
const unlocked = ref(Boolean(props.note._unlocked))

const isEncrypted = computed(() => props.note.encrypted)
const isPinned = computed(() => props.note.pinned)
const isOverdue = computed(() => {
  if (props.note.type !== 'memo' || !props.note.dueAt || props.note.completed) return false
  return new Date(props.note.dueAt).getTime() < Date.now()
})

const visibleContent = computed(() => (
  isEncrypted.value
    ? (unlocked.value ? decryptedContent.value : '')
    : (props.note.content || '')
))

const previewContent = computed(() => {
  if (isEncrypted.value && !unlocked.value) {
    return '已加密内容，点击解锁后可预览'
  }

  return visibleContent.value.slice(0, 100)
})

const previewTruncated = computed(() => (
  (!isEncrypted.value || unlocked.value) && visibleContent.value.length > 100
))

watch(
  () => [props.note.id, props.note.content],
  () => {
    unlocked.value = Boolean(props.note._unlocked)
    decryptedContent.value = props.note._unlocked ? String(props.note.content || '') : ''
    password.value = ''
    decryptError.value = false
  }
)

function formatDate(timestamp) {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatEntryDate(value) {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function formatDueAt(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function unlockedNote() {
  return unlocked.value
    ? { ...props.note, content: decryptedContent.value, _unlocked: true }
    : props.note
}

function runAction(action) {
  if (
    isEncrypted.value
    && !unlocked.value
    && ['preview', 'edit', 'ai', 'copyExtract'].includes(action)
  ) {
    unlockAction.value = action
    password.value = ''
    decryptError.value = false
    showPasswordModal.value = true
    return
  }

  emit(action, unlockedNote())
}

async function handleDecrypt() {
  if (!password.value) return

  const result = await decrypt(props.note.content, password.value)
  if (result !== null) {
    decryptedContent.value = result
    unlocked.value = true
    showPasswordModal.value = false
    decryptError.value = false
    password.value = ''
    emit(unlockAction.value, { ...props.note, content: result, _unlocked: true })
  } else {
    decryptError.value = true
  }
}
</script>

<template>
  <article
    class="note-card card-float"
    :class="{
      'is-pinned': isPinned,
      'is-encrypted': isEncrypted,
      'is-completed': note.completed
    }"
    tabindex="0"
    @click="runAction('preview')"
    @keydown.enter.self.prevent="runAction('preview')"
    @keydown.space.self.prevent="runAction('preview')"
  >
    <div class="note-card__type">
      <span v-if="isPinned" class="note-card__pin" title="已置顶">
        <Icon name="pin" :size="12" />
      </span>
      {{ note.type === 'memo' ? '备忘录' : '日记' }}
      <button
        v-if="note.numberId"
        type="button"
        class="note-card__id"
        :aria-label="`复制笔记数字 ID ${note.numberId}`"
        title="复制数字 ID"
        @click.stop="emit('copyId', note)"
      >
        <Icon name="copy" :size="11" />
        #{{ note.numberId }}
      </button>
      <span v-if="note.type === 'diary' && note.mood" class="note-card__mood">{{ note.mood }}</span>
    </div>

    <div class="note-card__title">{{ note.title }}</div>

    <div class="note-card__content">
      {{ previewContent }}
      <span v-if="previewTruncated">...</span>
    </div>

    <div v-if="note.type === 'diary' && note.entryDate" class="note-card__meta">
      <Icon name="calendar" :size="14" />
      <span>{{ formatEntryDate(note.entryDate) }}</span>
    </div>

    <div
      v-if="note.type === 'memo' && note.dueAt"
      class="note-card__meta"
      :class="{ 'is-overdue': isOverdue }"
    >
      <Icon name="clock" :size="14" />
      <span>{{ isOverdue ? '已逾期 · ' : '' }}{{ formatDueAt(note.dueAt) }}</span>
    </div>

    <div class="note-card__footer">
      <span class="note-card__date">{{ formatDate(note.updatedAt) }}</span>
      <span v-if="note.completed" class="note-card__completed">
        <Icon name="circle-check" :size="14" /> 已完成
      </span>
      <span v-if="note.share?.enabled" class="note-card__share-status">已分享</span>
    </div>

    <div class="note-card__actions" @click.stop>
      <button
        v-if="note.type === 'memo'"
        type="button"
        class="action-btn"
        :class="{ 'is-complete': note.completed }"
        :title="note.completed ? '恢复为待完成' : '标记为已完成'"
        :aria-label="note.completed ? `恢复 ${note.title} 为待完成` : `将 ${note.title} 标记为已完成`"
        @click="emit('toggleComplete', note)"
      >
        <Icon :name="note.completed ? 'refresh' : 'check'" :size="15" />
      </button>
      <button
        type="button"
        class="action-btn"
        :title="isPinned ? '取消置顶' : '置顶'"
        :aria-label="isPinned ? `取消置顶 ${note.title}` : `置顶 ${note.title}`"
        @click="emit('togglePin', note)"
      >
        <Icon name="pin" :size="15" />
      </button>
      <button
        v-if="isEncrypted && !unlocked"
        type="button"
        class="action-btn"
        title="解锁查看"
        :aria-label="`解锁 ${note.title}`"
        @click="unlockAction = 'preview'; showPasswordModal = true"
      >
        <Icon name="lock" :size="15" />
      </button>
      <button
        v-if="!isEncrypted"
        type="button"
        class="action-btn"
        title="分享"
        :aria-label="`分享 ${note.title}`"
        @click="emit('share', note)"
      >
        <Icon name="share" :size="15" />
      </button>
      <button
        type="button"
        class="action-btn action-btn--ai"
        title="使用 AI 编辑"
        :aria-label="`使用 AI 编辑 ${note.title}`"
        @click="runAction('ai')"
      >
        <Icon name="sparkles" :size="15" />
      </button>
      <button
        type="button"
        class="action-btn"
        title="快速复制整条笔记内容"
        :aria-label="`快速复制 ${note.title}`"
        @click="runAction('copyExtract')"
      >
        <Icon name="copy" :size="15" />
      </button>
      <button
        type="button"
        class="action-btn"
        title="编辑"
        :aria-label="`编辑 ${note.title}`"
        @click="runAction('edit')"
      >
        <Icon name="edit" :size="15" />
      </button>
      <button
        type="button"
        class="action-btn action-btn--danger"
        title="删除"
        :aria-label="`删除 ${note.title}`"
        @click="emit('delete', note)"
      >
        <Icon name="trash" :size="15" />
      </button>
    </div>

    <div
      v-if="showPasswordModal"
      class="password-modal"
      @click.stop
      @click.self="showPasswordModal = false"
    >
      <div class="password-modal__content" role="dialog" aria-modal="true" aria-label="解锁加密笔记">
        <div class="password-modal__icon"><Icon name="lock" :size="22" /></div>
        <h3>解锁加密笔记</h3>
        <input
          v-model="password"
          type="password"
          class="input"
          placeholder="请输入密码"
          @keydown.enter="handleDecrypt"
        >
        <p v-if="decryptError" class="error">密码错误或内容已损坏</p>
        <div class="password-modal__actions">
          <button type="button" class="btn btn--secondary" @click="showPasswordModal = false">取消</button>
          <button type="button" class="btn btn--primary" @click="handleDecrypt">解锁</button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.note-card {
  position: relative;
  padding: 52px 16px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-card);
  cursor: pointer;
  transition: all var(--transition-normal) var(--ease-smooth);
}

.note-card:hover {
  transform: translateY(-3px);
  box-shadow: var(--shadow-card-hover);
}

.note-card:focus-visible {
  border-color: var(--accent-color);
}

.note-card.is-pinned {
  border-left: 3px solid var(--accent-color);
}

.note-card.is-encrypted {
  background: color-mix(in srgb, var(--bg-card) 88%, var(--bg-secondary));
}

.note-card.is-completed {
  opacity: 0.74;
}

.note-card__pin {
  display: inline-flex;
  align-items: center;
  color: var(--accent-color);
}

.note-card__type {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.note-card__mood {
  padding: 2px 7px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: 999px;
}

.note-card__id {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-light);
  border-radius: 999px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.note-card__id:hover {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 48%, var(--border-light));
}

.note-card__title {
  margin-bottom: 8px;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}

.note-card__content {
  min-height: 42px;
  margin-bottom: 12px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.note-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -2px 0 11px;
  color: var(--text-muted);
  font-size: 12px;
}

.note-card__meta.is-overdue {
  color: var(--error-color);
}

.note-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.note-card__share-status,
.note-card__completed {
  color: var(--success-color);
}

.note-card__completed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.note-card__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  max-width: calc(100% - 16px);
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.note-card:hover .note-card__actions,
.note-card:focus-within .note-card__actions {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.action-btn {
  width: 29px;
  height: 29px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
  transform: translateY(-1px);
}

.action-btn--danger:hover {
  color: #fff;
  background: var(--error-color);
}

.action-btn--ai:hover {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 46%, var(--border-light));
  background: color-mix(in srgb, var(--accent-color) 9%, var(--bg-card));
}

.action-btn.is-complete {
  color: var(--success-color);
  border-color: color-mix(in srgb, var(--success-color) 45%, var(--border-light));
}

.password-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.5);
}

.password-modal__content {
  width: min(340px, 100%);
  padding: 24px;
  text-align: center;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.password-modal__icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  margin: 0 auto 12px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 14px;
}

.password-modal__content h3 {
  margin-bottom: 16px;
  color: var(--text-primary);
}

.input {
  width: 100%;
  padding: 12px 16px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
}

.error {
  margin: 10px 0 0;
  color: var(--error-color);
  font-size: 12px;
}

.password-modal__actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.btn {
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.btn--primary {
  color: #fff;
  background: var(--accent-color);
}

.btn--secondary {
  color: var(--text-primary);
  background: var(--bg-secondary);
}

@media (hover: none), (pointer: coarse) {
  .note-card__actions {
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }

}

@media (prefers-reduced-motion: reduce) {
  .note-card,
  .note-card__actions,
  .action-btn {
    transition: none;
  }

  .note-card:hover,
  .action-btn:hover {
    transform: none;
  }
}
</style>
