<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  bookmark: {
    type: Object,
    default: null
  },
  result: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  error: {
    type: String,
    default: ''
  },
  needsSetup: {
    type: Boolean,
    default: false
  },
  canGenerateTags: {
    type: Boolean,
    default: false
  },
  tagResult: {
    type: Object,
    default: null
  },
  tagLoading: {
    type: Boolean,
    default: false
  },
  tagSaving: {
    type: Boolean,
    default: false
  },
  tagError: {
    type: String,
    default: ''
  },
  tagMessage: {
    type: String,
    default: ''
  }
})

const emit = defineEmits([
  'close',
  'retry',
  'openSettings',
  'suggestTags',
  'applyTags'
])
const closeButton = ref(null)
const panelSheet = ref(null)
const copied = ref(false)
const copyError = ref('')

function handleKeydown(event) {
  if (event.key === 'Escape' && props.show) {
    emit('close')
    return
  }

  if (event.key === 'Tab' && props.show) {
    const focusable = [...(panelSheet.value?.querySelectorAll(
      'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])'
    ) || [])]
    if (!focusable.length) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

watch(
  () => props.show,
  async (show) => {
    copied.value = false
    copyError.value = ''
    document.body.style.overflow = show ? 'hidden' : ''

    if (show) {
      window.addEventListener('keydown', handleKeydown)
      await nextTick()
      closeButton.value?.focus()
    } else {
      window.removeEventListener('keydown', handleKeydown)
    }
  }
)

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', handleKeydown)
})

async function copyAnswer() {
  const answer = props.result?.answer
  if (!answer) return

  try {
    await navigator.clipboard.writeText(answer)
    copied.value = true
    copyError.value = ''
    window.setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch {
    copyError.value = '复制失败，请手动选择内容'
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ai-panel">
      <div
        v-if="show"
        class="ai-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bookmark-ai-title"
        @click.self="emit('close')"
      >
        <section ref="panelSheet" class="ai-panel__sheet">
          <header class="ai-panel__header">
            <div class="ai-panel__identity">
              <span class="ai-panel__mark" aria-hidden="true">
                <Icon name="sparkles" :size="20" />
              </span>
              <div>
                <p class="ai-panel__eyebrow">AI BOOKMARK INSIGHT</p>
                <h2 id="bookmark-ai-title">{{ bookmark?.title || '书签分析' }}</h2>
              </div>
            </div>
            <button
              ref="closeButton"
              class="ai-panel__close"
              type="button"
              aria-label="关闭 AI 分析"
              @click="emit('close')"
            >
              <Icon name="close" :size="18" />
            </button>
          </header>

          <div class="ai-panel__url">{{ bookmark?.url }}</div>

          <div v-if="loading" class="ai-panel__state" aria-live="polite">
            <span class="ai-panel__loader" aria-hidden="true"></span>
            <div>
              <strong>正在整理这个书签</strong>
              <p>AI 会依据书签标题、网址和已有描述，整理用途、标签与下一步建议。</p>
            </div>
          </div>

          <div v-else-if="error" class="ai-panel__state ai-panel__state--error" role="alert">
            <span class="ai-panel__state-icon" aria-hidden="true">
              <Icon name="alert" :size="20" />
            </span>
            <div>
              <strong>{{ needsSetup ? 'AI 尚未接入' : '这次分析没有完成' }}</strong>
              <p>{{ error }}</p>
            </div>
          </div>

          <template v-else-if="result">
            <article v-if="result.answer" class="ai-panel__answer">
              {{ result.answer }}
            </article>

            <section v-if="result.items?.length" class="ai-panel__sources">
              <div class="ai-panel__section-title">
                <Icon name="external-link" :size="15" />
                <span>{{ result.answer ? '参考来源' : '相关网页' }}</span>
              </div>
              <div class="ai-panel__source-list">
                <a
                  v-for="(item, index) in result.items"
                  :key="item.url || index"
                  class="ai-panel__source"
                  :href="item.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span class="ai-panel__source-meta">{{ item.source || '网页来源' }}</span>
                  <strong>{{ item.title }}</strong>
                  <span v-if="item.description">{{ item.description }}</span>
                </a>
              </div>
            </section>
          </template>

          <section
            v-if="!needsSetup && canGenerateTags"
            class="ai-panel__tag-workspace"
          >
            <div class="ai-panel__tag-heading">
              <span class="ai-panel__tag-icon" aria-hidden="true">
                <Icon name="tag" :size="17" />
              </span>
              <div>
                <strong>智能标签</strong>
                <p>单独生成可搜索的短标签，确认后才会保存到书签。</p>
              </div>
            </div>

            <div v-if="tagLoading" class="ai-panel__tag-state" aria-live="polite">
              <span class="ai-panel__loader" aria-hidden="true"></span>
              <span>正在生成 3–5 个标签</span>
            </div>

            <div v-if="tagError" class="ai-panel__tag-feedback is-error" role="alert">
              <Icon name="alert" :size="15" />
              <span>{{ tagError }}</span>
            </div>

            <div v-if="tagMessage" class="ai-panel__tag-feedback is-success" role="status">
              <Icon name="circle-check" :size="15" />
              <span>{{ tagMessage }}</span>
            </div>

            <template v-if="tagResult && !tagLoading">
              <div
                v-if="tagResult.tags?.length"
                class="ai-panel__tags"
                aria-label="AI 建议标签"
              >
                <span v-for="tag in tagResult.tags" :key="tag" class="ai-panel__tag">
                  <Icon name="tag" :size="13" />
                  {{ tag }}
                </span>
              </div>
              <p v-else class="ai-panel__tag-empty">没有发现适合添加的新标签。</p>
            </template>

            <div class="ai-panel__tag-actions">
              <button
                class="ai-panel__button"
                type="button"
                :disabled="loading || tagLoading || tagSaving"
                @click="emit('suggestTags')"
              >
                <span v-if="tagLoading" class="ai-panel__button-spinner" aria-hidden="true"></span>
                <Icon v-else name="sparkles" :size="16" />
                {{ tagResult ? '重新生成' : '生成标签' }}
              </button>
              <button
                v-if="tagResult?.tags?.length"
                class="ai-panel__button ai-panel__button--primary"
                type="button"
                :disabled="tagLoading || tagSaving"
                @click="emit('applyTags')"
              >
                <span v-if="tagSaving" class="ai-panel__button-spinner" aria-hidden="true"></span>
                <Icon v-else name="tag" :size="16" />
                {{ tagSaving ? '保存中' : `添加 ${tagResult.tags.length} 个标签` }}
              </button>
            </div>
          </section>

          <footer class="ai-panel__footer">
            <span class="ai-panel__hint">
              {{
                copyError ||
                (result?.model
                  ? `由 ${result.model} 根据书签元数据生成，未直接抓取该网页正文`
                  : '依据书签元数据整理，未直接抓取该网页正文')
              }}
            </span>
            <div class="ai-panel__actions">
              <button
                v-if="needsSetup"
                class="ai-panel__button ai-panel__button--primary"
                type="button"
                @click="emit('openSettings')"
              >
                <Icon name="settings" :size="16" />
                去设置 AI
              </button>
              <button
                v-else-if="error"
                class="ai-panel__button"
                type="button"
                @click="emit('retry')"
              >
                <Icon name="refresh" :size="16" />
                重试
              </button>
              <button
                v-if="result?.answer"
                class="ai-panel__button ai-panel__button--primary"
                type="button"
                @click="copyAnswer"
              >
                <Icon :name="copied ? 'check' : 'copy'" :size="16" />
                {{ copied ? '已复制' : '复制分析' }}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-panel {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #211c17 38%, transparent);
  backdrop-filter: blur(10px);
}

.ai-panel__sheet {
  width: min(720px, 100%);
  max-height: min(760px, calc(100vh - 48px));
  overflow-y: auto;
  padding: 24px;
  color: var(--text-primary);
  background:
    radial-gradient(circle at 8% 0%, color-mix(in srgb, var(--accent-color) 12%, transparent), transparent 34%),
    var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--border-light) 76%, transparent);
  border-radius: 30px;
  box-shadow:
    0 30px 90px color-mix(in srgb, #211c17 26%, transparent),
    0 1px 0 color-mix(in srgb, white 76%, transparent) inset;
}

.ai-panel__header,
.ai-panel__identity,
.ai-panel__footer,
.ai-panel__actions,
.ai-panel__section-title {
  display: flex;
  align-items: center;
}

.ai-panel__header,
.ai-panel__footer {
  justify-content: space-between;
  gap: 16px;
}

.ai-panel__identity {
  min-width: 0;
  gap: 13px;
}

.ai-panel__mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--accent-color);
  background: var(--accent-bg);
  border: 1px solid color-mix(in srgb, var(--accent-color) 24%, transparent);
  border-radius: 15px;
}

.ai-panel__eyebrow {
  margin: 0 0 3px;
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.16em;
}

.ai-panel h2 {
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: clamp(19px, 3vw, 24px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-panel__close {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid transparent;
  border-radius: 13px;
  cursor: pointer;
}

.ai-panel__close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.ai-panel__close:focus-visible,
.ai-panel__button:focus-visible,
.ai-panel__source:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.ai-panel__url {
  margin: 16px 0 18px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-panel__state {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  padding: 28px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-secondary) 86%, transparent);
  border: 1px solid var(--border-light);
  border-radius: 22px;
}

.ai-panel__state strong {
  display: block;
  margin-bottom: 6px;
  color: var(--text-primary);
  font-size: 16px;
}

.ai-panel__state p {
  margin: 0;
  line-height: 1.65;
}

.ai-panel__state--error {
  justify-content: flex-start;
  color: var(--error-color);
}

.ai-panel__state-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: color-mix(in srgb, var(--error-color) 10%, transparent);
  border-radius: 14px;
}

.ai-panel__loader {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 3px solid color-mix(in srgb, var(--accent-color) 20%, transparent);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: ai-spin 0.85s linear infinite;
}

.ai-panel__answer {
  padding: 20px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
  border: 1px solid var(--border-light);
  border-radius: 22px;
  line-height: 1.8;
  white-space: pre-wrap;
}

.ai-panel__sources {
  margin-top: 18px;
}

.ai-panel__section-title {
  gap: 7px;
  margin: 0 4px 9px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 650;
}

.ai-panel__source-list {
  display: grid;
  gap: 8px;
}

.ai-panel__source {
  display: grid;
  gap: 5px;
  padding: 14px 16px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid transparent;
  border-radius: 16px;
  text-decoration: none;
  transition:
    border-color var(--transition-fast),
    transform var(--transition-fast);
}

.ai-panel__source:hover {
  border-color: color-mix(in srgb, var(--accent-color) 34%, transparent);
  transform: translateY(-1px);
}

.ai-panel__source strong {
  color: var(--text-primary);
}

.ai-panel__source-meta {
  color: var(--text-muted);
  font-size: 11px;
}

.ai-panel__tag-workspace {
  display: grid;
  gap: 12px;
  margin-top: 18px;
  padding: 16px;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--accent-color) 9%, var(--bg-secondary)),
      var(--bg-secondary)
    );
  border: 1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-light));
  border-radius: 18px;
}

.ai-panel__tag-heading {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.ai-panel__tag-heading > div {
  min-width: 0;
}

.ai-panel__tag-heading strong {
  display: block;
  color: var(--text-primary);
  font-size: 14px;
}

.ai-panel__tag-heading p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.ai-panel__tag-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 10px;
}

.ai-panel__tag-state,
.ai-panel__tag-feedback {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-card) 82%, transparent);
  border-radius: 11px;
  font-size: 12px;
}

.ai-panel__tag-state .ai-panel__loader {
  width: 18px;
  height: 18px;
  border-width: 2px;
}

.ai-panel__tag-feedback.is-error {
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card));
}

.ai-panel__tag-feedback.is-success {
  color: var(--success-color);
  background: color-mix(in srgb, var(--success-color) 9%, var(--bg-card));
}

.ai-panel__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-panel__tag {
  min-height: 31px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border: 1px solid color-mix(in srgb, var(--accent-color) 24%, transparent);
  border-radius: 999px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.ai-panel__tag-empty {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.ai-panel__tag-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-panel__button-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ai-spin 0.75s linear infinite;
}

.ai-panel__footer {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-light);
}

.ai-panel__hint {
  color: var(--text-muted);
  font-size: 11px;
}

.ai-panel__actions {
  justify-content: flex-end;
  gap: 8px;
}

.ai-panel__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 13px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
}

.ai-panel__button--primary {
  color: #fff;
  background: var(--accent-color);
  border-color: var(--accent-color);
}

.ai-panel__button:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}

.ai-panel-enter-active,
.ai-panel-leave-active {
  transition: opacity var(--transition-normal);
}

.ai-panel-enter-active .ai-panel__sheet,
.ai-panel-leave-active .ai-panel__sheet {
  transition:
    opacity var(--transition-normal),
    transform var(--transition-normal) var(--ease-smooth);
}

.ai-panel-enter-from,
.ai-panel-leave-to,
.ai-panel-enter-from .ai-panel__sheet,
.ai-panel-leave-to .ai-panel__sheet {
  opacity: 0;
}

.ai-panel-enter-from .ai-panel__sheet,
.ai-panel-leave-to .ai-panel__sheet {
  transform: translateY(14px) scale(0.985);
}

@keyframes ai-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .ai-panel {
    align-items: end;
    padding: 0;
  }

  .ai-panel__sheet {
    max-height: 88vh;
    padding: 20px 16px;
    border-radius: 26px 26px 0 0;
  }

  .ai-panel__footer {
    align-items: stretch;
    flex-direction: column;
  }

  .ai-panel__actions,
  .ai-panel__button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-panel,
  .ai-panel__sheet,
  .ai-panel__source {
    transition: none;
  }

  .ai-panel__source:hover {
    transform: none;
  }

  .ai-panel__loader,
  .ai-panel__button-spinner {
    animation-duration: 1.8s;
  }
}
</style>
