<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  canUseBackendNoteAi,
  runBackendNoteAi
} from '@/shared/services/noteAiApi'

const props = defineProps({
  type: {
    type: String,
    default: 'memo'
  },
  title: {
    type: String,
    default: ''
  },
  content: {
    type: String,
    default: ''
  },
  encrypted: {
    type: Boolean,
    default: false
  },
  autoOpen: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['insert', 'replace'])

const actions = [
  { id: 'summarize', label: '总结', icon: 'list' },
  { id: 'polish', label: '润色', icon: 'edit' },
  { id: 'tasks', label: '提取待办', icon: 'check' },
  { id: 'continue', label: '续写', icon: 'plus' }
]

const expanded = ref(props.autoOpen)
const workingAction = ref('')
const result = ref(null)
const errorMessage = ref('')
const copied = ref(false)
let requestSequence = 0

const canRun = computed(() => (
  canUseBackendNoteAi()
  && Boolean(props.content.trim())
  && !props.disabled
  && !workingAction.value
))

watch(
  () => props.autoOpen,
  (value) => {
    if (value) expanded.value = true
  }
)

watch(
  () => [props.type, props.title, props.content],
  () => {
    requestSequence += 1
    if (result.value) {
      result.value = null
    }
    copied.value = false
    errorMessage.value = workingAction.value
      ? '正文已更改，本次 AI 草稿已作废；请求结束后请重新生成。'
      : ''
  }
)

async function runAction(action) {
  expanded.value = true
  errorMessage.value = ''
  copied.value = false

  if (!canUseBackendNoteAi()) {
    errorMessage.value = 'AI 编辑仅在服务器登录模式下可用。'
    return
  }

  if (!props.content.trim()) {
    errorMessage.value = '请先写一些正文，再调用 AI。'
    return
  }

  if (
    props.encrypted
    && !window.confirm('AI 编辑会把当前明文发送到你在后台配置的 AI 服务。确定继续吗？')
  ) {
    return
  }

  workingAction.value = action
  result.value = null
  const requestId = ++requestSequence
  const snapshot = {
    type: props.type,
    title: props.title,
    content: props.content
  }

  try {
    const response = await runBackendNoteAi(action, snapshot)
    if (requestId !== requestSequence) return
    result.value = response
  } catch (error) {
    if (requestId !== requestSequence) return
    errorMessage.value = error.message || 'AI 编辑失败，请稍后重试。'
  } finally {
    workingAction.value = ''
  }
}

async function copyResult() {
  if (!result.value?.text) return

  try {
    await navigator.clipboard.writeText(result.value.text)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch {
    errorMessage.value = '复制失败，请选中预览内容后手动复制。'
  }
}

function applyResult(mode) {
  if (!result.value?.text) return
  emit(mode, result.value.text)
  result.value = null
  errorMessage.value = ''
}
</script>

<template>
  <section class="note-ai" :class="{ 'is-expanded': expanded }">
    <button
      type="button"
      class="note-ai__trigger"
      :aria-expanded="expanded"
      aria-controls="note-ai-workspace"
      :disabled="disabled"
      @click="expanded = !expanded"
    >
      <span class="note-ai__trigger-icon"><Icon name="sparkles" :size="17" /></span>
      <span>
        <strong>AI 编辑</strong>
        <small>后台安全代理，不在浏览器读取 API Key</small>
      </span>
      <Icon class="note-ai__chevron" name="plus" :size="16" />
    </button>

    <div v-if="expanded" id="note-ai-workspace" class="note-ai__workspace">
      <div class="note-ai__actions" aria-label="AI 编辑操作">
        <button
          v-for="action in actions"
          :key="action.id"
          type="button"
          class="note-ai__action"
          :class="{ 'is-loading': workingAction === action.id }"
          :disabled="!canRun"
          @click="runAction(action.id)"
        >
          <span v-if="workingAction === action.id" class="note-ai__spinner" aria-hidden="true"></span>
          <Icon v-else :name="action.icon" :size="15" />
          {{ action.label }}
        </button>
      </div>

      <p v-if="!canUseBackendNoteAi()" class="note-ai__hint">
        当前为本地模式。请使用服务器账户并在设置中启用 AI 服务。
      </p>
      <p v-else class="note-ai__hint">
        点击操作会把当前标题和正文发送到后台已配置的模型。AI 只生成草稿，确认后再插入或替换。
      </p>

      <div v-if="errorMessage" class="note-ai__error" role="alert">
        <Icon name="alert" :size="16" />
        <span>{{ errorMessage }}</span>
      </div>

      <div v-if="result" class="note-ai__result" aria-live="polite">
        <div class="note-ai__result-header">
          <div>
            <span class="note-ai__result-kicker">AI 草稿</span>
            <strong>{{ result.label }}</strong>
          </div>
          <span class="note-ai__model">{{ result.model }}</span>
        </div>
        <pre>{{ result.text }}</pre>
        <div class="note-ai__result-actions">
          <button type="button" class="note-ai__secondary" @click="copyResult">
            <Icon :name="copied ? 'circle-check' : 'copy'" :size="15" />
            {{ copied ? '已复制' : '复制结果' }}
          </button>
          <button type="button" class="note-ai__secondary" @click="applyResult('insert')">
            <Icon name="plus" :size="15" /> 插入正文末尾
          </button>
          <button type="button" class="note-ai__primary" @click="applyResult('replace')">
            <Icon name="edit" :size="15" /> 替换正文
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.note-ai {
  margin: 0 24px 16px;
  overflow: hidden;
  color: var(--text-primary);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent-color) 10%, var(--bg-card)), var(--bg-card) 48%);
  border: 1px solid color-mix(in srgb, var(--accent-color) 24%, var(--border-light));
  border-radius: 18px;
}

.note-ai__trigger {
  width: 100%;
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 13px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}

.note-ai__trigger:focus-visible,
.note-ai__action:focus-visible,
.note-ai__primary:focus-visible,
.note-ai__secondary:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent-color) 28%, transparent);
  outline-offset: -3px;
}

.note-ai__trigger-icon {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 11px;
}

.note-ai__trigger > span:nth-child(2) {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.note-ai__trigger strong {
  font-size: 13px;
}

.note-ai__trigger small {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-ai__chevron {
  margin-left: auto;
  transition: transform var(--transition-fast);
}

.is-expanded .note-ai__chevron {
  transform: rotate(45deg);
}

.note-ai__workspace {
  display: grid;
  gap: 12px;
  padding: 0 13px 13px;
  border-top: 1px solid color-mix(in srgb, var(--accent-color) 16%, var(--border-light));
}

.note-ai__actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
  padding-top: 12px;
}

.note-ai__action,
.note-ai__primary,
.note-ai__secondary {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-card) 88%, transparent);
  border: 1px solid var(--border-light);
  border-radius: 11px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}

.note-ai__action:hover:not(:disabled),
.note-ai__secondary:hover {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 52%, var(--border-light));
  transform: translateY(-1px);
}

.note-ai__action:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.note-ai__hint {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.55;
}

.note-ai__error {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 10px 11px;
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card));
  border-radius: 11px;
  font-size: 12px;
}

.note-ai__result {
  padding: 13px;
  background: color-mix(in srgb, var(--bg-card) 96%, var(--accent-color));
  border: 1px solid var(--border-light);
  border-radius: 14px;
}

.note-ai__result-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.note-ai__result-header > div {
  display: grid;
  gap: 2px;
}

.note-ai__result-kicker,
.note-ai__model {
  color: var(--text-muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.note-ai__model {
  max-width: 44%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-ai__result pre {
  max-height: 210px;
  margin: 12px 0;
  overflow: auto;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.note-ai__result-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  flex-wrap: wrap;
}

.note-ai__primary {
  color: #fff;
  background: var(--accent-color);
  border-color: transparent;
}

.note-ai__primary:hover {
  background: var(--accent-hover);
}

.note-ai__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: note-ai-spin 0.75s linear infinite;
}

@keyframes note-ai-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 560px) {
  .note-ai {
    margin-inline: 16px;
  }

  .note-ai__actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .note-ai__result-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .note-ai__chevron,
  .note-ai__action,
  .note-ai__primary,
  .note-ai__secondary {
    transition: none;
  }
}
</style>
