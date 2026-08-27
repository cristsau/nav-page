<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { searchEmailAi } from '@/shared/services/emailApi'

const props = defineProps({
  open: { type: Boolean, default: false }
})

const emit = defineEmits(['close'])
const dialogRef = ref(null)
const inputRef = ref(null)
const question = ref('')
const loading = ref(false)
const errorMessage = ref('')
const answer = ref('')
const sources = ref([])
let restoreTarget = null
let requestSequence = 0

function answerText(payload) {
  const result = payload?.result
  if (typeof result === 'string') return result.trim()
  return String(result?.text || result?.content || result?.summary || result?.data?.summary || '').trim()
}

function normalizeSources(value) {
  return (Array.isArray(value) ? value : []).slice(0, 8).map((source, index) => ({
    sourceId: String(source?.sourceId || `M${index + 1}`).slice(0, 12),
    messageId: String(source?.messageId || ''),
    subject: String(source?.subject || '（无主题）').slice(0, 500),
    sender: String(source?.sender || '').slice(0, 320),
    receivedAt: source?.receivedAt || '',
    preview: String(source?.preview || '').slice(0, 280)
  }))
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

async function searchMailbox() {
  const value = question.value.trim()
  if (value.length < 2 || loading.value) return
  const sequence = ++requestSequence
  loading.value = true
  errorMessage.value = ''
  answer.value = ''
  sources.value = []
  try {
    const payload = await searchEmailAi({ search: value, question: value, answer: true })
    if (sequence !== requestSequence) return
    answer.value = answerText(payload)
    sources.value = normalizeSources(payload?.sources)
    if (!answer.value && !sources.value.length) {
      errorMessage.value = '没有找到可用于回答的邮件。可以换一个更具体的发件人、主题或关键词。'
    }
  } catch (error) {
    if (sequence !== requestSequence) return
    errorMessage.value = error?.message || '全邮箱 AI 检索失败'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function close() {
  requestSequence += 1
  loading.value = false
  emit('close')
}

function focusableElements() {
  return Array.from(dialogRef.value?.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
  ) || []).filter((element) => element.offsetParent !== null)
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const elements = focusableElements()
  if (!elements.length) return
  const first = elements[0]
  const last = elements.at(-1)
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
    inputRef.value?.focus()
    return
  }
  requestSequence += 1
  loading.value = false
  await nextTick()
  restoreTarget?.focus?.()
  restoreTarget = null
})

onBeforeUnmount(() => {
  requestSequence += 1
  restoreTarget?.focus?.()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mail-ai-search-dialog" role="presentation" @mousedown.self="close">
      <section ref="dialogRef" role="dialog" aria-modal="true" aria-labelledby="mail-ai-search-title" aria-describedby="mail-ai-search-description" @keydown="onKeydown">
        <header>
          <div>
            <span><Icon name="sparkles" :size="20" /></span>
            <div><h2 id="mail-ai-search-title">问整个邮箱</h2><p id="mail-ai-search-description">在最近邮件中安全检索并用来源回答，不会联网或修改原邮箱。</p></div>
          </div>
          <button type="button" aria-label="关闭全邮箱 AI 检索" @click="close"><Icon name="close" :size="19" /></button>
        </header>

        <form @submit.prevent="searchMailbox">
          <label for="mail-ai-search-question">问题或检索词</label>
          <div>
            <Icon name="search" :size="18" />
            <input id="mail-ai-search-question" ref="inputRef" v-model="question" type="search" minlength="2" maxlength="240" autocomplete="off" placeholder="例如：最近哪些邮件提到了服务器迁移和截止日期？">
            <button type="submit" :disabled="question.trim().length < 2 || loading"><Icon name="sparkles" :size="17" />{{ loading ? '检索中…' : '检索并回答' }}</button>
          </div>
        </form>

        <p v-if="errorMessage" class="mail-ai-search-dialog__error" role="alert">{{ errorMessage }}</p>
        <div v-else-if="loading" class="mail-ai-search-dialog__loading" role="status"><Icon name="refresh" :size="18" />正在解密有限范围内的候选邮件并生成回答…</div>
        <div v-else-if="answer || sources.length" class="mail-ai-search-dialog__result" aria-live="polite">
          <section v-if="answer" aria-labelledby="mail-ai-search-answer-title">
            <h3 id="mail-ai-search-answer-title">AI 回答</h3>
            <pre>{{ answer }}</pre>
          </section>
          <section v-if="sources.length" aria-labelledby="mail-ai-search-sources-title">
            <h3 id="mail-ai-search-sources-title">依据来源 · {{ sources.length }}</h3>
            <ol>
              <li v-for="source in sources" :key="`${source.sourceId}-${source.messageId}`">
                <span>{{ source.sourceId }}</span>
                <div>
                  <strong>{{ source.subject }}</strong>
                  <small>{{ source.sender || '未知发件人' }}<template v-if="formatDate(source.receivedAt)"> · {{ formatDate(source.receivedAt) }}</template></small>
                  <p>{{ source.preview || '没有可显示的正文摘录。' }}</p>
                </div>
              </li>
            </ol>
          </section>
          <p>AI 可能理解有误，请结合上方来源核对。</p>
        </div>
        <div v-else class="mail-ai-search-dialog__empty">
          <span><Icon name="mail" :size="24" /></span>
          <h3>从你的邮件中找答案</h3>
          <p>可询问发件人、主题、交付节点、账单、安全提醒或跨邮件变化。敏感值会先脱敏。</p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mail-ai-search-dialog { position: fixed; z-index: 1400; inset: 0; display: grid; padding: 22px; place-items: center; background: color-mix(in srgb, #000 62%, transparent); backdrop-filter: blur(12px); }
.mail-ai-search-dialog > section { display: grid; width: min(840px, 100%); max-height: min(780px, calc(100dvh - 44px)); overflow: hidden; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 21px; box-shadow: var(--shadow-modal, 0 24px 80px rgb(0 0 0 / .24)); }
.mail-ai-search-dialog > section > header { display: flex; min-height: 86px; padding: 16px 18px; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border-light); }
.mail-ai-search-dialog > section > header > div { display: flex; min-width: 0; align-items: center; gap: 11px; }
.mail-ai-search-dialog > section > header > div > span { display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 13px; }
.mail-ai-search-dialog h2, .mail-ai-search-dialog h3 { margin: 0; }
.mail-ai-search-dialog h2 { font-size: .94rem; }
.mail-ai-search-dialog header p { margin: 4px 0 0; color: var(--text-muted); font-size: .62rem; line-height: 1.5; }
.mail-ai-search-dialog header button { display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-ai-search-dialog form { display: grid; padding: 15px 18px; gap: 7px; border-bottom: 1px solid var(--border-light); }
.mail-ai-search-dialog form > label { color: var(--text-muted); font-size: .61rem; font-weight: 700; }
.mail-ai-search-dialog form > div { display: grid; min-height: 50px; padding-left: 13px; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 14px; }
.mail-ai-search-dialog form svg { color: var(--text-muted); }
.mail-ai-search-dialog input { min-width: 0; min-height: 46px; color: var(--text-primary); font: inherit; font-size: .69rem; background: transparent; border: 0; outline: 0; }
.mail-ai-search-dialog form button { display: inline-flex; min-height: 44px; margin-right: 3px; padding: 0 13px; align-items: center; justify-content: center; gap: 6px; color: var(--accent-contrast, #fff); font: inherit; font-size: .62rem; font-weight: 720; background: var(--accent-color); border: 0; border-radius: 11px; cursor: pointer; }
.mail-ai-search-dialog form button:disabled { opacity: .5; cursor: not-allowed; }
.mail-ai-search-dialog__error, .mail-ai-search-dialog__loading { margin: 14px 18px 0; padding: 12px; font-size: .65rem; line-height: 1.55; border-radius: 11px; }
.mail-ai-search-dialog__error { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 24%, transparent); }
.mail-ai-search-dialog__loading { display: flex; align-items: center; gap: 7px; color: var(--accent-color); background: var(--accent-bg); }
.mail-ai-search-dialog__result { display: grid; padding: 17px 18px 20px; overflow-y: auto; gap: 17px; }
.mail-ai-search-dialog__result > section { display: grid; gap: 9px; }
.mail-ai-search-dialog__result h3 { font-size: .68rem; }
.mail-ai-search-dialog__result pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .68rem; line-height: 1.72; }
.mail-ai-search-dialog__result ol { display: grid; margin: 0; padding: 0; gap: 7px; list-style: none; }
.mail-ai-search-dialog__result li { display: grid; padding: 10px; grid-template-columns: auto minmax(0, 1fr); gap: 9px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-ai-search-dialog__result li > span { display: grid; min-width: 34px; height: 28px; padding-inline: 5px; place-items: center; color: var(--accent-color); font-size: .57rem; font-weight: 760; background: var(--accent-bg); border-radius: 8px; }
.mail-ai-search-dialog__result li > div { display: grid; min-width: 0; gap: 3px; }
.mail-ai-search-dialog__result strong { overflow-wrap: anywhere; font-size: .65rem; }
.mail-ai-search-dialog__result small, .mail-ai-search-dialog__result p { color: var(--text-muted); font-size: .57rem; line-height: 1.5; }
.mail-ai-search-dialog__result li p { display: -webkit-box; margin: 2px 0 0; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mail-ai-search-dialog__result > p { margin: 0; }
.mail-ai-search-dialog__empty { display: grid; min-height: 290px; padding: 28px; place-content: center; justify-items: center; text-align: center; }
.mail-ai-search-dialog__empty > span { display: grid; width: 54px; height: 54px; margin-bottom: 12px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 16px; }
.mail-ai-search-dialog__empty h3 { font-size: .8rem; }
.mail-ai-search-dialog__empty p { max-width: 480px; margin: 7px 0 0; color: var(--text-muted); font-size: .63rem; line-height: 1.6; }
@media (max-width: 700px) {
  .mail-ai-search-dialog { padding: 0; align-items: end; }
  .mail-ai-search-dialog > section { width: 100%; max-height: calc(100dvh - 12px); border-radius: 22px 22px 0 0; }
  .mail-ai-search-dialog > section > header { padding: 13px 14px; }
  .mail-ai-search-dialog form { padding: 13px 14px; }
  .mail-ai-search-dialog form > div { padding: 7px 7px 7px 12px; grid-template-columns: auto minmax(0, 1fr); }
  .mail-ai-search-dialog form button { min-height: 44px; grid-column: 1 / -1; }
  .mail-ai-search-dialog__result { padding: 15px 14px calc(24px + env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  .mail-ai-search-dialog { backdrop-filter: none; }
}
</style>
