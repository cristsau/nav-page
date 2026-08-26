<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import AiUsagePanel from '@/modules/settings/components/AiUsagePanel.vue'
import {
  deleteAssistantConversation,
  fetchAssistantConversation,
  fetchAssistantConversations,
  streamAssistantMessage,
  updateAssistantConversationPreferences
} from '@/shared/services/assistantApi'
import { fetchBackendChatModels } from '@/shared/services/aiSearchApi'
import {
  AUTO_CHAT_MODEL_OPTION_ID,
  buildChatModelPicker
} from '@/shared/config/aiModels'
import { fetchEmailEvent } from '@/shared/services/emailApi'

const route = useRoute()
const router = useRouter()
const conversations = ref([])
const activeConversation = ref(null)
const messages = ref([])
const conversationSearch = ref('')
const question = ref('')
const loadingConversations = ref(false)
const loadingConversation = ref(false)
const sending = ref(false)
const agentStatus = ref('')
const preferenceSaving = ref(false)
const errorMessage = ref('')
const pendingSend = ref(null)
const emailDetail = ref(null)
const emailLoading = ref(false)
const usageExpanded = ref(false)
const composer = ref(null)
const messageList = ref(null)
const assistantPreferences = ref({
  modelMode: 'latest',
  model: '',
  reasoningEffort: 'low'
})
const modelCatalog = ref({
  models: [],
  latestModel: '',
  apiMode: 'responses',
  source: ''
})
const modelCatalogLoading = ref(false)
const modelCatalogError = ref('')
let streamController = null

const TOOL_LABELS = Object.freeze({
  get_current_datetime: '读取当前时间',
  search_workspace: '检索站内资料',
  list_navigation_groups: '读取导航分组',
  search_bookmarks: '检索导航书签',
  create_diary: '创建日记',
  create_memo: '创建备忘录',
  create_bookmark: '保存导航书签',
  create_group: '创建导航分组'
})

function toolLabel(tool) {
  return TOOL_LABELS[tool] || '执行助理工具'
}

function createAssistantOperationId() {
  return globalThis.crypto?.randomUUID?.()
    || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
      const value = Math.floor(Math.random() * 16)
      return (token === 'x' ? value : ((value & 0x3) | 0x8)).toString(16)
    })
}

function actionOutcome(action) {
  if (action?.summary?.deduplicated) return '已存在，未重复创建'
  if (action?.summary?.created) return '创建成功'
  if (action?.status === 'failed') return '执行失败'
  return '操作完成'
}

const canSend = computed(() => Boolean(question.value.trim()) && !sending.value)
const activeTitle = computed(() => activeConversation.value?.title || '新的对话')
const modelPicker = computed(() => buildChatModelPicker({
  currentModel: assistantPreferences.value.model,
  modelMode: assistantPreferences.value.modelMode,
  discoveredModels: modelCatalog.value.models,
  latestModel: modelCatalog.value.latestModel
}))
const modelOptions = computed(() => {
  if (modelCatalog.value.models.length) return modelPicker.value.options
  if (assistantPreferences.value.modelMode === 'pinned' && assistantPreferences.value.model) {
    return [{
      id: assistantPreferences.value.model,
      label: assistantPreferences.value.model,
      description: '当前对话配置'
    }]
  }
  return []
})
const usesResponsesApi = computed(() => modelCatalog.value.apiMode === 'responses')
const controlsDisabled = computed(() => sending.value || preferenceSaving.value)

function preferencesFromConversation(conversation) {
  return {
    modelMode: conversation?.modelMode === 'pinned' ? 'pinned' : 'latest',
    model: conversation?.model || '',
    reasoningEffort: conversation?.reasoningEffort || 'low'
  }
}

function replaceConversationInList(conversation) {
  const index = conversations.value.findIndex((item) => item.id === conversation?.id)
  if (index >= 0) conversations.value.splice(index, 1, conversation)
}

async function savePreferences(nextPreferences) {
  if (controlsDisabled.value) return
  const previous = { ...assistantPreferences.value }
  assistantPreferences.value = nextPreferences
  errorMessage.value = ''
  if (!activeConversation.value?.id) return

  preferenceSaving.value = true
  try {
    const result = await updateAssistantConversationPreferences(
      activeConversation.value.id,
      nextPreferences
    )
    activeConversation.value = result.conversation
    replaceConversationInList(result.conversation)
  } catch (error) {
    assistantPreferences.value = previous
    errorMessage.value = error.message || '对话模型设置保存失败'
  } finally {
    preferenceSaving.value = false
  }
}

function selectModel(value) {
  const pinned = value !== AUTO_CHAT_MODEL_OPTION_ID
  void savePreferences({
    ...assistantPreferences.value,
    modelMode: pinned ? 'pinned' : 'latest',
    model: pinned ? value : ''
  })
}

function selectReasoningEffort(value) {
  void savePreferences({
    ...assistantPreferences.value,
    reasoningEffort: value
  })
}

async function loadModelCatalog() {
  modelCatalogLoading.value = true
  modelCatalogError.value = ''
  try {
    modelCatalog.value = await fetchBackendChatModels()
  } catch (error) {
    modelCatalogError.value = error.message || '模型列表加载失败'
  } finally {
    modelCatalogLoading.value = false
  }
}

function formatDate(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function sourceLabel(source) {
  return source.kindLabel || ({
    bookmark: '导航',
    note: '笔记',
    email: '邮件',
    reminder: '提醒'
  }[source.kind] || '来源')
}

async function scrollToLatest() {
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
}

async function loadConversations() {
  loadingConversations.value = true
  errorMessage.value = ''
  try {
    const result = await fetchAssistantConversations(conversationSearch.value)
    conversations.value = result.conversations || []
  } catch (error) {
    errorMessage.value = error.message || '对话列表加载失败'
  } finally {
    loadingConversations.value = false
  }
}

async function openConversation(conversationId) {
  if (sending.value) return
  loadingConversation.value = true
  errorMessage.value = ''
  try {
    const result = await fetchAssistantConversation(conversationId)
    activeConversation.value = result.conversation
    assistantPreferences.value = preferencesFromConversation(result.conversation)
    messages.value = result.messages || []
    await scrollToLatest()
  } catch (error) {
    errorMessage.value = error.message || '对话加载失败'
  } finally {
    loadingConversation.value = false
  }
}

function startNewConversation() {
  if (sending.value) return
  activeConversation.value = null
  assistantPreferences.value = preferencesFromConversation(null)
  messages.value = []
  errorMessage.value = ''
  nextTick(() => composer.value?.focus())
}

async function removeConversation(conversation) {
  if (sending.value) return
  if (!window.confirm(`确定删除对话“${conversation.title}”吗？此操作无法撤销。`)) return
  try {
    await deleteAssistantConversation(conversation.id)
    conversations.value = conversations.value.filter((item) => item.id !== conversation.id)
    if (activeConversation.value?.id === conversation.id) startNewConversation()
  } catch (error) {
    errorMessage.value = error.message || '删除对话失败'
  }
}

function exportConversation() {
  if (!messages.value.length) return
  const title = activeTitle.value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
  const content = [
    `# ${activeTitle.value}`,
    '',
    ...messages.value.flatMap((message) => [
      `## ${message.role === 'user' ? '我' : 'DOMO 助理'}`,
      '',
      message.content,
      '',
      ...(message.sources?.length
        ? ['来源：', ...message.sources.map((source) => `- [${source.sourceId}]${source.recordId ? ` ID ${source.recordId}` : ''} ${source.title}`), '']
        : [])
    ])
  ].join('\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${title || 'DOMO-NAV-对话'}.md`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function sendQuestion(options = {}) {
  const retryPendingSend = options?.retry === true && pendingSend.value
    ? { ...pendingSend.value }
    : null
  const text = retryPendingSend?.query || question.value.trim()
  if (!text || sending.value) return
  if (retryPendingSend) {
    pendingSend.value = retryPendingSend
  } else {
    pendingSend.value = {
      query: text,
      operationId: createAssistantOperationId()
    }
    question.value = ''
  }
  const operationId = pendingSend.value.operationId
  sending.value = true
  agentStatus.value = ''
  errorMessage.value = ''
  const userMessage = {
    id: `local-user-${Date.now()}`,
    role: 'user',
    content: text,
    sources: [],
    createdAt: new Date().toISOString()
  }
  const assistantMessage = {
    id: `local-assistant-${Date.now()}`,
    role: 'assistant',
    content: '',
    sources: [],
    actions: [],
    createdAt: new Date().toISOString(),
    streaming: true
  }
  messages.value.push(userMessage, assistantMessage)
  await scrollToLatest()
  streamController = new AbortController()

  try {
    await streamAssistantMessage({
      conversationId: activeConversation.value?.id || '',
      query: text,
      ...assistantPreferences.value,
      operationId,
      signal: streamController.signal,
      onEvent(event, payload) {
        if (event === 'conversation') {
          activeConversation.value = payload.conversation
          assistantPreferences.value = preferencesFromConversation(payload.conversation)
          Object.assign(userMessage, payload.userMessage || {})
        } else if (event === 'sources') {
          assistantMessage.sources = payload.sources || []
        } else if (event === 'delta') {
          assistantMessage.content += payload.delta || ''
          void scrollToLatest()
        } else if (event === 'reset') {
          assistantMessage.content = payload.content || ''
        } else if (event === 'agent_status') {
          agentStatus.value = payload.label || '助理正在处理…'
        } else if (event === 'tool_start') {
          agentStatus.value = `${toolLabel(payload.tool)}…`
        } else if (event === 'tool_result') {
          agentStatus.value = payload.ok
            ? `${toolLabel(payload.tool)}完成`
            : `${toolLabel(payload.tool)}失败`
        } else if (event === 'action' && payload.receipt) {
          if (!assistantMessage.actions.some((item) => item.operationId === payload.receipt.operationId)) {
            assistantMessage.actions.push(payload.receipt)
          }
        } else if (event === 'done') {
          Object.assign(assistantMessage, payload.message || {}, {
            actions: payload.actions || payload.message?.actions || assistantMessage.actions,
            streaming: false
          })
          agentStatus.value = ''
        } else if (event === 'error') {
          errorMessage.value = payload.error || '助理回答失败'
        }
      }
    })
    assistantMessage.streaming = false
    if (pendingSend.value?.operationId === operationId) pendingSend.value = null
    await loadConversations()
  } catch (error) {
    assistantMessage.streaming = false
    if (error.name !== 'AbortError') {
      errorMessage.value = error.message || '助理回答失败，请稍后重试'
      if (!assistantMessage.content) assistantMessage.content = '本次回答未完成，可重试本次请求。'
    }
  } finally {
    sending.value = false
    agentStatus.value = ''
    streamController = null
    await scrollToLatest()
    nextTick(() => composer.value?.focus())
  }
}

function retryLastQuestion() {
  if (!pendingSend.value || sending.value) return
  void sendQuestion({ retry: true })
}

async function loadLinkedEmail(emailId) {
  emailDetail.value = null
  if (!emailId) return
  emailLoading.value = true
  try {
    emailDetail.value = await fetchEmailEvent(emailId)
  } catch (error) {
    errorMessage.value = error.message || '邮件详情加载失败'
  } finally {
    emailLoading.value = false
  }
}

async function closeEmailPanel() {
  emailDetail.value = null
  const query = { ...route.query }
  delete query.email
  await router.replace({ path: route.path, query })
}

function handleComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendQuestion()
  }
}

function handleUsageToggle(event) {
  usageExpanded.value = event.currentTarget?.open === true
}

watch(() => route.query.email, (value) => {
  void loadLinkedEmail(String(value || ''))
})

onMounted(async () => {
  await Promise.all([
    loadConversations(),
    loadModelCatalog(),
    loadLinkedEmail(String(route.query.email || ''))
  ])
  composer.value?.focus()
})

onBeforeUnmount(() => streamController?.abort())
</script>

<template>
  <main class="assistant-page">
    <aside class="assistant-sidebar" aria-label="对话历史">
      <div class="assistant-sidebar__header">
        <div>
          <span class="assistant-eyebrow">DOMO 助理</span>
          <h1>你的资料，一个入口</h1>
        </div>
        <button type="button" aria-label="新建对话" title="新建对话" @click="startNewConversation">
          <Icon name="plus" :size="18" />
        </button>
      </div>
      <form class="assistant-history-search" role="search" @submit.prevent="loadConversations">
        <Icon name="search" :size="16" />
        <input v-model="conversationSearch" aria-label="搜索历史对话" placeholder="搜索历史对话" type="search">
      </form>
      <p v-if="loadingConversations" class="assistant-sidebar__status">正在读取历史…</p>
      <p v-else-if="!conversations.length" class="assistant-sidebar__status">还没有历史对话。问我一件事，第一条对话会自动保存。</p>
      <div v-else class="assistant-history">
        <article
          v-for="conversation in conversations"
          :key="conversation.id"
          :class="{ 'is-active': activeConversation?.id === conversation.id }"
        >
          <button class="assistant-history__open" type="button" @click="openConversation(conversation.id)">
            <strong>{{ conversation.title }}</strong>
            <span>{{ conversation.preview || '空对话' }}</span>
            <time>{{ formatDate(conversation.updatedAt) }}</time>
          </button>
          <button
            class="assistant-history__delete"
            type="button"
            :aria-label="`删除对话 ${conversation.title}`"
            @click="removeConversation(conversation)"
          >
            <Icon name="trash" :size="15" />
          </button>
        </article>
      </div>
      <details class="assistant-usage" @toggle="handleUsageToggle">
        <summary>
          <span><Icon name="sparkles" :size="15" />用量与成本</span>
          <Icon name="chevron-down" :size="15" />
        </summary>
        <AiUsagePanel v-if="usageExpanded" />
      </details>
    </aside>

    <section class="assistant-workspace" aria-label="助理对话">
      <header class="assistant-workspace__header">
        <div class="assistant-workspace__title">
          <span class="assistant-eyebrow">站内优先 AI 助理</span>
          <h2>{{ activeTitle }}</h2>
        </div>
        <div class="assistant-model-controls" aria-label="当前对话 AI 设置">
          <label>
            <span>模型</span>
            <select
              :value="modelPicker.selectionValue"
              :disabled="controlsDisabled || modelCatalogLoading"
              aria-label="选择当前对话模型"
              @change="selectModel($event.target.value)"
            >
              <option :value="AUTO_CHAT_MODEL_OPTION_ID">
                自动 · {{ modelPicker.latestModel }}
              </option>
              <option
                v-for="model in modelOptions"
                :key="model.id"
                :value="model.id"
              >
                {{ model.label }}
              </option>
            </select>
          </label>
          <label :class="{ 'is-disabled': !usesResponsesApi }">
            <span>思考</span>
            <select
              :value="assistantPreferences.reasoningEffort"
              :disabled="controlsDisabled || !usesResponsesApi"
              aria-label="选择当前对话推理强度"
              @change="selectReasoningEffort($event.target.value)"
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">极高</option>
              <option value="max">最大</option>
              <option value="ultra">超强</option>
            </select>
          </label>
          <span v-if="preferenceSaving" class="assistant-model-controls__status" role="status">保存中…</span>
          <span v-else-if="modelCatalogError" class="assistant-model-controls__status is-warning" role="status">仅可使用自动模式</span>
        </div>
        <button
          class="assistant-export"
          type="button"
          :disabled="!messages.length"
          title="导出 Markdown"
          @click="exportConversation"
        >
          <Icon name="download" :size="17" />
          <span>导出</span>
        </button>
      </header>

      <div ref="messageList" class="assistant-messages" aria-live="polite">
        <div v-if="loadingConversation" class="assistant-welcome">正在读取对话…</div>
        <div v-else-if="!messages.length" class="assistant-welcome">
          <span class="assistant-welcome__icon"><Icon name="sparkles" :size="24" /></span>
          <h2>今天想找什么？</h2>
          <p>我可以从导航、笔记、备忘录、到期提醒和已接入的邮件里检索，并把依据放在回答下方。</p>
          <div class="assistant-suggestions">
            <button type="button" @click="question = '我今天有哪些需要处理的事情？'; sendQuestion()">我今天要处理什么？</button>
            <button type="button" @click="question = '帮我找最近保存的部署配置'; sendQuestion()">找最近的部署配置</button>
            <button type="button" @click="question = '有哪些重要邮件需要我核对？'; sendQuestion()">查看重要邮件</button>
          </div>
        </div>

        <template v-else>
          <article
            v-for="message in messages"
            :key="message.id"
            :class="['assistant-message', `is-${message.role}`]"
          >
            <div class="assistant-message__role">
              <Icon :name="message.role === 'user' ? 'user' : 'sparkles'" :size="16" />
              <span>{{ message.role === 'user' ? '我' : 'DOMO 助理' }}</span>
              <span v-if="message.role === 'assistant' && message.model" class="assistant-message__model">{{ message.model }}</span>
            </div>
            <div class="assistant-message__content">{{ message.content }}<span v-if="message.streaming" class="assistant-caret" aria-label="正在生成"></span></div>
            <div v-if="message.actions?.length" class="assistant-actions" aria-label="助理操作回执">
              <component
                :is="action.href ? RouterLink : 'span'"
                v-for="action in message.actions"
                :key="action.operationId"
                :to="action.href || undefined"
                class="assistant-action"
              >
                <span class="assistant-action__icon"><Icon name="circle-check" :size="17" /></span>
                <span>
                  <strong>{{ toolLabel(action.tool) }}</strong>
                  <small>{{ actionOutcome(action) }} · ID {{ action.operationId }}</small>
                </span>
                <Icon v-if="action.href" name="external-link" :size="15" />
              </component>
            </div>
            <div v-if="message.sources?.length" class="assistant-sources" aria-label="回答来源">
              <component
                :is="source.href?.startsWith('/') ? RouterLink : 'a'"
                v-for="source in message.sources"
                :key="source.sourceId"
                :to="source.href?.startsWith('/') ? source.href : undefined"
                :href="source.href?.startsWith('/') ? undefined : source.href"
                :target="source.href?.startsWith('/') ? undefined : '_blank'"
                :rel="source.href?.startsWith('/') ? undefined : 'noopener noreferrer'"
              >
                <span>{{ source.sourceId }} · {{ sourceLabel(source) }}<template v-if="source.recordId"> · ID {{ source.recordId }}</template></span>
                <strong>{{ source.title }}</strong>
                <small>{{ source.excerpt }}</small>
              </component>
            </div>
          </article>
        </template>
      </div>

      <p v-if="agentStatus" class="assistant-agent-status" role="status">
        <Icon name="sparkles" :size="15" />{{ agentStatus }}
      </p>
      <div v-if="errorMessage" class="assistant-error" role="alert">
        <span>{{ errorMessage }}</span>
        <button v-if="pendingSend" type="button" :disabled="sending" @click="retryLastQuestion">
          <Icon name="refresh-cw" :size="15" />
          重试本次请求
        </button>
      </div>
      <form class="assistant-composer" @submit.prevent="sendQuestion">
        <label for="assistant-question">向 DOMO 助理提问</label>
        <textarea
          id="assistant-question"
          ref="composer"
          v-model="question"
          rows="2"
          maxlength="500"
          placeholder="例如：我今天有哪些重要邮件和到期备忘录？"
          @keydown="handleComposerKeydown"
        ></textarea>
        <div>
              <span>可检索站内与网页；明确要求时可安全创建日记、备忘录、书签和分组</span>
          <button type="submit" :disabled="!canSend">
            <Icon name="sparkles" :size="17" />
            {{ sending ? '回答中…' : '发送' }}
          </button>
        </div>
      </form>
    </section>

    <aside v-if="emailLoading || emailDetail" class="assistant-email" aria-label="邮件详情">
      <header>
        <div>
          <span class="assistant-eyebrow">邮件证据</span>
          <h2>{{ emailDetail?.subject || '正在读取邮件…' }}</h2>
        </div>
        <button type="button" aria-label="关闭邮件详情" @click="closeEmailPanel">
          <Icon name="close" :size="18" />
        </button>
      </header>
      <div v-if="emailDetail" class="assistant-email__body">
        <dl>
          <div><dt>发件人</dt><dd>{{ emailDetail.senderName || emailDetail.senderAddress }}</dd></div>
          <div><dt>时间</dt><dd>{{ formatDate(emailDetail.receivedAt) }}</dd></div>
          <div><dt>级别</dt><dd>Tier {{ emailDetail.tier }} · {{ emailDetail.urgency }}</dd></div>
          <div><dt>判断原因</dt><dd>{{ emailDetail.reason }}</dd></div>
          <div><dt>建议操作</dt><dd>{{ emailDetail.suggestedAction }}</dd></div>
        </dl>
        <section>
          <h3>正文</h3>
          <pre>{{ emailDetail.body }}</pre>
        </section>
      </div>
    </aside>
  </main>
</template>

<style scoped>
.assistant-page {
  display: grid;
  min-height: calc(100vh - var(--app-shell-header-height, 64px));
  grid-template-columns: 280px minmax(0, 1fr);
  color: var(--text-primary);
  background: var(--bg-primary);
}
.assistant-page:has(.assistant-email) { grid-template-columns: 260px minmax(0, 1fr) minmax(300px, 360px); }
.assistant-sidebar,
.assistant-email { min-width: 0; background: var(--bg-secondary); }
.assistant-sidebar { display: flex; max-height: calc(100vh - var(--app-shell-header-height, 64px)); flex-direction: column; border-right: 1px solid var(--border-light); }
.assistant-sidebar__header,
.assistant-email > header { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.assistant-workspace__header { display: grid; align-items: center; grid-template-columns: minmax(120px, 1fr) auto auto; gap: 14px; }
.assistant-workspace__title { min-width: 0; }
.assistant-workspace__title h2 { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.assistant-sidebar__header { padding: 24px 18px 16px; }
.assistant-sidebar h1,
.assistant-workspace h2,
.assistant-email h2 { margin: 4px 0 0; font-size: 1rem; line-height: 1.35; }
.assistant-eyebrow { color: var(--accent-color); font-size: 0.68rem; font-weight: 760; letter-spacing: 0.08em; text-transform: uppercase; }
.assistant-sidebar button,
.assistant-workspace__header button,
.assistant-email > header button { min-width: 44px; min-height: 44px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 12px; cursor: pointer; }
.assistant-sidebar button:hover,
.assistant-sidebar button:focus-visible,
.assistant-workspace__header button:hover,
.assistant-workspace__header button:focus-visible,
.assistant-email > header button:hover,
.assistant-email > header button:focus-visible { color: var(--text-primary); background: var(--bg-hover); }
.assistant-history-search { display: flex; min-height: 44px; margin: 0 14px 10px; padding: 0 12px; align-items: center; gap: 8px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; }
.assistant-history-search input { min-width: 0; flex: 1; color: var(--text-primary); background: transparent; border: 0; outline: 0; }
.assistant-history-search input::placeholder { color: var(--text-muted); }
.assistant-sidebar__status { padding: 18px; color: var(--text-muted); font-size: 0.78rem; line-height: 1.6; }
.assistant-history { min-height: 0; padding: 4px 8px 20px; overflow-y: auto; }
.assistant-usage { margin: auto 10px 12px; border-top: 1px solid var(--border-light); }
.assistant-usage summary { display: flex; min-height: 44px; padding: 0 8px; align-items: center; justify-content: space-between; color: var(--text-secondary); cursor: pointer; list-style: none; font-size: 0.72rem; font-weight: 720; }
.assistant-usage summary::-webkit-details-marker { display: none; }
.assistant-usage summary span { display: inline-flex; align-items: center; gap: 7px; }
.assistant-usage[open] summary > :last-child { transform: rotate(180deg); }
.assistant-usage :deep(.usage-panel) { max-height: min(58vh, 560px); margin: 0 0 8px; padding: 10px; overflow-y: auto; border-radius: 14px; }
.assistant-usage :deep(.usage-panel__header) { align-items: flex-start; flex-direction: column; }
.assistant-usage :deep(.usage-panel__actions) { width: 100%; justify-content: space-between; }
.assistant-usage :deep(.usage-panel__metrics) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.assistant-usage :deep(.usage-panel__metrics > div:last-child) { grid-column: 1 / -1; }
.assistant-usage :deep(.usage-panel__row) { align-items: flex-start; flex-direction: column; }
.assistant-history article { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 40px; margin: 2px 0; border-radius: 14px; }
.assistant-history article.is-active { background: var(--accent-bg); }
.assistant-history__open { display: grid; min-width: 0; padding: 10px 6px 10px 11px; text-align: left; }
.assistant-history__open strong,
.assistant-history__open span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.assistant-history__open strong { color: var(--text-primary); font-size: 0.78rem; }
.assistant-history__open span,
.assistant-history__open time { color: var(--text-muted); font-size: 0.67rem; }
.assistant-history__delete { align-self: center; opacity: 0; }
.assistant-history article:hover .assistant-history__delete,
.assistant-history__delete:focus-visible { opacity: 1; }
.assistant-workspace { display: grid; min-width: 0; min-height: 0; max-height: calc(100vh - var(--app-shell-header-height, 64px)); grid-template-rows: auto minmax(0, 1fr) auto auto; }
.assistant-workspace__header { min-height: 74px; padding: 14px clamp(20px, 4vw, 48px); border-bottom: 1px solid var(--border-light); }
.assistant-workspace__header button { display: inline-flex; padding: 0 12px; align-items: center; gap: 7px; }
.assistant-workspace__header button:disabled { opacity: 0.45; cursor: not-allowed; }
.assistant-model-controls { display: flex; min-width: 0; align-items: center; gap: 8px; }
.assistant-model-controls label { display: flex; min-width: 0; min-height: 42px; padding: 4px 9px; align-items: center; gap: 6px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; }
.assistant-model-controls label:focus-within { border-color: var(--accent-color); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 9%, transparent); }
.assistant-model-controls label > span { flex: 0 0 auto; color: var(--text-muted); font-size: 0.64rem; font-weight: 720; }
.assistant-model-controls select { max-width: 190px; min-width: 90px; color: var(--text-primary); font: inherit; font-size: 0.72rem; font-weight: 680; background: transparent; border: 0; outline: 0; cursor: pointer; }
.assistant-model-controls label:nth-child(2) select { max-width: 72px; min-width: 52px; }
.assistant-model-controls label.is-disabled { opacity: 0.52; }
.assistant-model-controls__status { color: var(--text-muted); font-size: 0.65rem; }
.assistant-model-controls__status.is-warning { color: var(--warning-color); }
.assistant-messages { min-height: 0; padding: 28px clamp(20px, 6vw, 84px); overflow-y: auto; scroll-behavior: smooth; }
.assistant-welcome { max-width: 680px; margin: 11vh auto 0; text-align: center; }
.assistant-welcome__icon { display: grid; width: 58px; height: 58px; margin: 0 auto 18px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 18px; }
.assistant-welcome h2 { margin: 0; font-size: clamp(1.55rem, 3vw, 2.3rem); }
.assistant-welcome p { max-width: 580px; margin: 14px auto 24px; color: var(--text-secondary); line-height: 1.8; }
.assistant-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.assistant-suggestions button { min-height: 44px; padding: 0 14px; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px; cursor: pointer; }
.assistant-suggestions button:hover,
.assistant-suggestions button:focus-visible { color: var(--text-primary); border-color: var(--accent-color); }
.assistant-message { width: min(760px, 100%); margin: 0 auto 30px; }
.assistant-message.is-user { width: min(660px, 92%); margin-right: max(0px, calc((100% - 760px) / 2)); }
.assistant-message__role { display: flex; margin-bottom: 9px; align-items: center; gap: 7px; color: var(--text-muted); font-size: 0.7rem; font-weight: 720; }
.assistant-message__model { padding: 2px 7px; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px; font-size: 0.61rem; font-weight: 640; }
.assistant-message__content { padding: 17px 19px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.78; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 18px; }
.assistant-message.is-user .assistant-message__content { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 30%, var(--border-light)); }
.assistant-caret { display: inline-block; width: 7px; height: 1.1em; margin-left: 3px; vertical-align: -2px; background: var(--accent-color); animation: assistant-blink 0.8s steps(2, start) infinite; }
.assistant-actions { display: grid; margin-top: 9px; gap: 7px; }
.assistant-action { display: grid; min-height: 58px; padding: 10px 12px; align-items: center; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 9px; color: var(--text-primary); text-decoration: none; background: color-mix(in srgb, var(--success-color, #4f8a5b) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--success-color, #4f8a5b) 28%, var(--border-light)); border-radius: 14px; }
.assistant-action[href]:hover,
.assistant-action[href]:focus-visible { border-color: var(--success-color, #4f8a5b); }
.assistant-action__icon { display: grid; width: 32px; height: 32px; place-items: center; color: var(--success-color, #4f8a5b); background: color-mix(in srgb, var(--success-color, #4f8a5b) 12%, transparent); border-radius: 10px; }
.assistant-action > span:nth-child(2) { display: grid; min-width: 0; gap: 2px; }
.assistant-action strong { font-size: 0.75rem; }
.assistant-action small { overflow: hidden; color: var(--text-muted); font-size: 0.65rem; text-overflow: ellipsis; }
.assistant-sources { display: grid; margin-top: 9px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 7px; }
.assistant-sources a { display: grid; min-width: 0; padding: 11px 12px; gap: 4px; color: var(--text-primary); text-decoration: none; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; }
.assistant-sources a:hover,
.assistant-sources a:focus-visible { border-color: var(--accent-color); }
.assistant-sources span,
.assistant-sources small { color: var(--text-muted); font-size: 0.66rem; }
.assistant-sources strong,
.assistant-sources small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.assistant-sources strong { font-size: 0.75rem; }
.assistant-error { display: flex; width: min(760px, calc(100% - 40px)); min-height: 44px; margin: 0 auto 8px; padding: 8px 9px 8px 13px; align-items: center; justify-content: space-between; gap: 10px; color: var(--error-color); background: color-mix(in srgb, var(--error-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 28%, transparent); border-radius: 12px; font-size: 0.75rem; }
.assistant-error span { min-width: 0; overflow-wrap: anywhere; }
.assistant-error button { display: inline-flex; min-height: 44px; padding: 0 11px; flex: 0 0 auto; align-items: center; gap: 6px; color: var(--error-color); background: var(--bg-card); border: 1px solid color-mix(in srgb, var(--error-color) 30%, var(--border-light)); border-radius: 10px; cursor: pointer; font: inherit; font-weight: 700; }
.assistant-error button:hover,
.assistant-error button:focus-visible { border-color: var(--error-color); }
.assistant-error button:disabled { opacity: 0.55; cursor: not-allowed; }
.assistant-agent-status { display: flex; width: min(760px, calc(100% - 40px)); min-height: 34px; margin: 0 auto 8px; padding: 7px 12px; align-items: center; gap: 7px; color: var(--accent-color); background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-light)); border-radius: 12px; font-size: 0.72rem; }
.assistant-composer { width: min(820px, calc(100% - 40px)); margin: 0 auto 22px; padding: 10px 12px 8px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 18px; box-shadow: var(--shadow-md); }
.assistant-composer:focus-within { border-color: var(--accent-color); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-color) 10%, transparent); }
.assistant-composer > label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
.assistant-composer textarea { display: block; width: 100%; min-height: 58px; padding: 7px 5px; resize: none; color: var(--text-primary); font: inherit; line-height: 1.5; background: transparent; border: 0; outline: 0; }
.assistant-composer textarea::placeholder { color: var(--text-muted); }
.assistant-composer > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.assistant-composer > div > span { color: var(--text-muted); font-size: 0.66rem; }
.assistant-composer button { display: inline-flex; min-height: 42px; padding: 0 16px; align-items: center; gap: 7px; color: var(--bg-primary); background: var(--accent-color); border: 0; border-radius: 13px; cursor: pointer; }
.assistant-composer button:disabled { opacity: 0.45; cursor: not-allowed; }
.assistant-email { max-height: calc(100vh - var(--app-shell-header-height, 64px)); overflow-y: auto; border-left: 1px solid var(--border-light); }
.assistant-email > header { position: sticky; top: 0; z-index: 2; min-height: 74px; padding: 14px 16px; background: color-mix(in srgb, var(--bg-secondary) 94%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(14px); }
.assistant-email > header div { min-width: 0; }
.assistant-email > header h2 { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.assistant-email__body { padding: 18px; }
.assistant-email dl { display: grid; margin: 0; gap: 13px; }
.assistant-email dl div { display: grid; gap: 4px; }
.assistant-email dt { color: var(--text-muted); font-size: 0.66rem; }
.assistant-email dd { margin: 0; overflow-wrap: anywhere; font-size: 0.76rem; line-height: 1.55; }
.assistant-email section { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border-light); }
.assistant-email section h3 { font-size: 0.78rem; }
.assistant-email pre { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: 0.73rem; line-height: 1.7; }
@keyframes assistant-blink { 50% { opacity: 0; } }

@media (max-width: 1100px) {
  .assistant-page,
  .assistant-page:has(.assistant-email) { grid-template-columns: 230px minmax(0, 1fr); }
  .assistant-email { position: fixed; top: var(--app-shell-header-height, 64px); right: 0; bottom: 0; z-index: 610; width: min(390px, 92vw); box-shadow: var(--shadow-lg); }
  .assistant-workspace__header { grid-template-columns: minmax(100px, 1fr) auto; }
  .assistant-export { display: none !important; }
}

@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .assistant-page,
  .assistant-page:has(.assistant-email) { min-height: calc(100vh - var(--app-shell-header-height, 64px)); padding-bottom: 84px; grid-template-columns: 1fr; }
  .assistant-sidebar { max-height: none; border-right: 0; border-bottom: 1px solid var(--border-light); }
  .assistant-sidebar__header { padding: 14px 14px 8px; }
  .assistant-sidebar__header h1 { display: none; }
  .assistant-history-search { margin: 0 12px 8px; }
  .assistant-history { display: flex; padding: 0 10px 10px; overflow-x: auto; }
  .assistant-usage { margin: 0 12px 10px; }
  .assistant-usage :deep(.usage-panel) { max-height: none; }
  .assistant-history article { min-width: 190px; flex: 0 0 190px; }
  .assistant-history__delete { opacity: 1; }
  .assistant-workspace { max-height: none; min-height: calc(100vh - 210px); grid-template-rows: auto minmax(360px, 1fr) auto auto; }
  .assistant-workspace__header { min-height: 62px; padding: 10px 14px; align-items: start; grid-template-columns: 1fr; gap: 8px; }
  .assistant-model-controls { width: 100%; overflow-x: auto; }
  .assistant-model-controls label { flex: 0 0 auto; }
  .assistant-model-controls label:first-child { flex: 1 0 180px; }
  .assistant-model-controls label:first-child select { max-width: none; min-width: 0; flex: 1; }
  .assistant-workspace__header button span { display: none; }
  .assistant-messages { padding: 20px 14px; }
  .assistant-welcome { margin-top: 6vh; }
  .assistant-message,
  .assistant-message.is-user { width: 100%; margin-right: auto; }
  .assistant-composer { width: calc(100% - 24px); margin-bottom: 12px; }
  .assistant-composer > div > span { display: none; }
  .assistant-email { top: var(--app-shell-header-height, 64px); bottom: 80px; }
}

@media (prefers-reduced-motion: reduce) {
  .assistant-messages { scroll-behavior: auto; }
  .assistant-caret { animation: none; }
}
</style>
