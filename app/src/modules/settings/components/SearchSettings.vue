<script setup>
import { computed, onMounted, ref } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'
import Icon from '@/shared/components/Icon.vue'
import { getCustomEngines, addCustomEngine, updateCustomEngine, deleteCustomEngine } from '@/shared/db/database'
import { testBackendAiProvider } from '@/shared/services/aiSearchApi'
import {
  createBackendCustomSearchEngine,
  deleteBackendCustomSearchEngine,
  fetchBackendCustomSearchEngines,
  shouldUseBackendSearchEngines,
  updateBackendCustomSearchEngine
} from '@/shared/services/searchEnginesApi'

const { config, updateConfig, getAllSearchEngines, loadCustomSearchEngines } = useConfig()

const customEngines = ref([])
const showAddModal = ref(false)
const editingEngine = ref(null)
const formData = ref({
  name: '',
  icon: 'S',
  url: ''
})

const providerTesting = ref({
  chatgpt: false,
  brave: false,
  openclaw: false
})

const providerMessages = ref({
  chatgpt: '',
  brave: '',
  openclaw: ''
})

const providerMessageTypes = ref({
  chatgpt: '',
  brave: '',
  openclaw: ''
})

const allEngines = computed(() => getAllSearchEngines())
const aggregateEnabled = computed(() => config.value.search?.aggregate?.enabled || false)
const quickAccessIds = computed(() => config.value.search?.quickAccessEngineIds || [])

async function loadCustomEngines() {
  try {
    customEngines.value = shouldUseBackendSearchEngines()
      ? await fetchBackendCustomSearchEngines()
      : await getCustomEngines()
  } catch {
    customEngines.value = []
  }
}

onMounted(async () => {
  await loadCustomEngines()
  await loadCustomSearchEngines()
})

function selectEngine(engineId) {
  updateConfig('searchEngine', engineId)
}

function toggleQuickAccess(engineId) {
  const list = [...quickAccessIds.value]
  const index = list.indexOf(engineId)

  if (index >= 0) {
    list.splice(index, 1)
  } else {
    list.push(engineId)
  }

  updateConfig('search.quickAccessEngineIds', list)
}

function isQuickAccess(engineId) {
  return quickAccessIds.value.includes(engineId)
}

function openAddModal() {
  editingEngine.value = null
  formData.value = { name: '', icon: 'S', url: '' }
  showAddModal.value = true
}

function editEngine(engine) {
  editingEngine.value = engine
  formData.value = { name: engine.name, icon: engine.icon, url: engine.url }
  showAddModal.value = true
}

async function saveEngine() {
  if (!formData.value.name || !formData.value.url) {
    alert('请填写名称和 URL')
    return
  }

  if (editingEngine.value) {
    if (shouldUseBackendSearchEngines()) {
      await updateBackendCustomSearchEngine(editingEngine.value.id, formData.value)
    } else {
      await updateCustomEngine(editingEngine.value.id, formData.value)
    }
  } else if (shouldUseBackendSearchEngines()) {
    await createBackendCustomSearchEngine(formData.value)
  } else {
    await addCustomEngine(formData.value)
  }

  showAddModal.value = false
  await loadCustomEngines()
  await loadCustomSearchEngines()
}

async function removeEngine(engine) {
  if (!confirm(`确定删除 ${engine.name} 吗？`)) return

  if (shouldUseBackendSearchEngines()) {
    await deleteBackendCustomSearchEngine(engine.id)
  } else {
    await deleteCustomEngine(engine.id)
  }

  await loadCustomEngines()
  await loadCustomSearchEngines()
}

function toggleAggregate() {
  updateConfig('search.aggregate.enabled', !aggregateEnabled.value)
}

function toggleAggregateEngine(engineId) {
  const engines = [...(config.value.search?.aggregate?.engines || [])]
  const index = engines.indexOf(engineId)

  if (index >= 0) {
    engines.splice(index, 1)
  } else {
    engines.push(engineId)
  }

  updateConfig('search.aggregate.engines', engines)
}

function isAggregateEngine(engineId) {
  return (config.value.search?.aggregate?.engines || []).includes(engineId)
}

function setProviderMessage(provider, type, message) {
  providerMessages.value[provider] = message
  providerMessageTypes.value[provider] = type
}

function updateChatApiMode(apiMode) {
  updateConfig('search.providers.chatgpt.apiMode', apiMode)

  const endpoint = String(config.value.search?.providers?.chatgpt?.endpoint || '').trim()
  const officialEndpoints = [
    '',
    'https://api.openai.com/v1/responses',
    'https://api.openai.com/v1/chat/completions'
  ]

  if (officialEndpoints.includes(endpoint)) {
    updateConfig(
      'search.providers.chatgpt.endpoint',
      apiMode === 'responses'
        ? 'https://api.openai.com/v1/responses'
        : 'https://api.openai.com/v1/chat/completions'
    )
  }
}

async function handleProviderTest(provider) {
  providerTesting.value[provider] = true
  setProviderMessage(provider, '', '')

  try {
    const providerConfig = { ...(config.value.search?.providers?.[provider] || {}) }
    const result = await testBackendAiProvider(provider, providerConfig)
    setProviderMessage(provider, 'success', result.message || '连接成功')
  } catch (error) {
    setProviderMessage(provider, 'error', error.message || '连接失败')
  } finally {
    providerTesting.value[provider] = false
  }
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">搜索设置</h3>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">默认搜索引擎</div>
        <div class="settings-item__desc">支持百度、Google、Bing、Brave Search、ChatGPT Search、OpenClaw 和自定义搜索。</div>
      </div>
      <div class="settings-item__control">
        <div class="engine-grid">
          <button
            v-for="engine in allEngines"
            :key="engine.id"
            class="engine-option"
            :class="{ 'is-active': config.searchEngine === engine.id }"
            @click="selectEngine(engine.id)"
          >
            <span class="engine-option__icon">{{ engine.icon }}</span>
            <span class="engine-option__name">{{ engine.name }}</span>
            <div v-if="!engine.isBuiltIn" class="engine-option__actions" @click.stop>
              <button class="action-btn" @click="editEngine(engine)">编辑</button>
              <button class="action-btn action-btn--danger" @click="removeEngine(engine)">删除</button>
            </div>
          </button>
          <button class="engine-option engine-option--add" @click="openAddModal">
            <span class="engine-option__icon">+</span>
            <span class="engine-option__name">添加</span>
          </button>
        </div>
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">首页快速切换</div>
        <div class="settings-item__desc">这里勾选的引擎，才会显示在导航首页搜索框的切换菜单里。</div>
      </div>
      <div class="checkbox-grid">
        <label
          v-for="engine in allEngines"
          :key="`${engine.id}-quick`"
          class="checkbox-item"
          :class="{ 'is-checked': isQuickAccess(engine.id) }"
        >
          <input
            type="checkbox"
            :checked="isQuickAccess(engine.id)"
            @change="toggleQuickAccess(engine.id)"
          >
          <span>{{ engine.icon }}</span>
          <span>{{ engine.name }}</span>
        </label>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">聚合搜索</div>
        <div class="settings-item__desc">一次搜索时同时打开多个网页搜索引擎。</div>
      </div>
      <div class="settings-item__control">
        <label class="toggle">
          <input type="checkbox" :checked="aggregateEnabled" @change="toggleAggregate">
          <span class="toggle__slider"></span>
        </label>
      </div>
    </div>

    <div v-if="aggregateEnabled" class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">聚合引擎列表</div>
        <div class="settings-item__desc">勾选后会在一次搜索中批量打开这些网页引擎。</div>
      </div>
      <div class="checkbox-grid">
        <label
          v-for="engine in allEngines"
          :key="`${engine.id}-aggregate`"
          class="checkbox-item"
          :class="{ 'is-checked': isAggregateEngine(engine.id) }"
        >
          <input
            type="checkbox"
            :checked="isAggregateEngine(engine.id)"
            @change="toggleAggregateEngine(engine.id)"
          >
          <span>{{ engine.icon }}</span>
          <span>{{ engine.name }}</span>
        </label>
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">ChatGPT / OpenAI 接入</div>
        <div class="settings-item__desc">推荐使用 Responses API；开启联网搜索后，答案下方会显示可点击的引用来源。</div>
      </div>
      <div class="provider-grid">
        <label class="provider-field">
          <span>启用</span>
          <input
            type="checkbox"
            :checked="config.search?.providers?.chatgpt?.enabled"
            @change="updateConfig('search.providers.chatgpt.enabled', $event.target.checked)"
          >
        </label>
        <label class="provider-field">
          <span>接入模式</span>
          <select
            class="input"
            :value="config.search?.providers?.chatgpt?.mode"
            @change="updateConfig('search.providers.chatgpt.mode', $event.target.value)"
          >
            <option value="proxy">CLI Proxy / API Management Center</option>
            <option value="api">OpenAI-Compatible API</option>
          </select>
        </label>
        <label class="provider-field">
          <span>API 格式</span>
          <select
            class="input"
            :value="config.search?.providers?.chatgpt?.apiMode || (config.search?.providers?.chatgpt?.cliProxyBaseUrl ? 'chat-completions' : 'responses')"
            @change="updateChatApiMode($event.target.value)"
          >
            <option value="responses">Responses API（推荐）</option>
            <option value="chat-completions">Chat Completions（兼容网关）</option>
          </select>
        </label>
        <label class="provider-field">
          <span>Proxy Base URL</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.chatgpt?.cliProxyBaseUrl"
            placeholder="https://your-proxy.example.com"
            @input="updateConfig('search.providers.chatgpt.cliProxyBaseUrl', $event.target.value)"
          >
        </label>
        <label class="provider-field">
          <span>API Endpoint</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.chatgpt?.endpoint"
            placeholder="https://api.openai.com/v1/responses"
            @input="updateConfig('search.providers.chatgpt.endpoint', $event.target.value)"
          >
        </label>
        <label class="provider-field">
          <span>API Key</span>
          <input
            class="input"
            type="password"
            :value="config.search?.providers?.chatgpt?.apiKey"
            placeholder="输入 API Key"
            @input="updateConfig('search.providers.chatgpt.apiKey', $event.target.value)"
          >
        </label>
        <label class="provider-field">
          <span>Model</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.chatgpt?.model"
            placeholder="gpt-5.6-terra"
            @input="updateConfig('search.providers.chatgpt.model', $event.target.value)"
          >
        </label>
        <label class="provider-field">
          <span>推理强度</span>
          <select
            class="input"
            :value="config.search?.providers?.chatgpt?.reasoningEffort || 'low'"
            @change="updateConfig('search.providers.chatgpt.reasoningEffort', $event.target.value)"
          >
            <option value="none">无</option>
            <option value="minimal">极低</option>
            <option value="low">低（推荐）</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="xhigh">极高</option>
          </select>
        </label>
        <label class="provider-field provider-field--toggle">
          <span>联网搜索</span>
          <input
            type="checkbox"
            :checked="config.search?.providers?.chatgpt?.webSearchEnabled !== false"
            @change="updateConfig('search.providers.chatgpt.webSearchEnabled', $event.target.checked)"
          >
        </label>
      </div>
      <div class="provider-actions">
        <button type="button" class="btn btn--secondary" :disabled="providerTesting.chatgpt" @click="handleProviderTest('chatgpt')">
          <Icon :name="providerTesting.chatgpt ? 'refresh' : 'check'" :size="16" />
          {{ providerTesting.chatgpt ? '测试中...' : '测试连接' }}
        </button>
      </div>
      <div
        v-if="providerMessages.chatgpt"
        class="provider-message"
        :class="`is-${providerMessageTypes.chatgpt}`"
      >
        {{ providerMessages.chatgpt }}
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">Brave Search API 接入</div>
        <div class="settings-item__desc">配置完成后，首页切到 Brave Search 会优先在页面内显示结果卡片。</div>
      </div>
      <div class="provider-grid">
        <label class="provider-field">
          <span>启用</span>
          <input
            type="checkbox"
            :checked="config.search?.providers?.brave?.enabled"
            @change="updateConfig('search.providers.brave.enabled', $event.target.checked)"
          >
        </label>
        <label class="provider-field">
          <span>Endpoint</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.brave?.endpoint"
            placeholder="https://api.search.brave.com/res/v1/web/search"
            @input="updateConfig('search.providers.brave.endpoint', $event.target.value)"
          >
        </label>
        <label class="provider-field provider-field--full">
          <span>API Key</span>
          <input
            class="input"
            type="password"
            :value="config.search?.providers?.brave?.apiKey"
            placeholder="输入 Brave Search API Key"
            @input="updateConfig('search.providers.brave.apiKey', $event.target.value)"
          >
        </label>
      </div>
      <div class="provider-actions">
        <button class="btn btn--secondary" :disabled="providerTesting.brave" @click="handleProviderTest('brave')">
          {{ providerTesting.brave ? '测试中...' : '测试连接' }}
        </button>
      </div>
      <div
        v-if="providerMessages.brave"
        class="provider-message"
        :class="`is-${providerMessageTypes.brave}`"
      >
        {{ providerMessages.brave }}
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">OpenClaw 接入</div>
        <div class="settings-item__desc">适合接你自己的 OpenClaw 或 OpenAI-compatible 网关，配置完成后首页会直接返回答案面板。</div>
      </div>
      <div class="provider-grid">
        <label class="provider-field">
          <span>启用</span>
          <input
            type="checkbox"
            :checked="config.search?.providers?.openclaw?.enabled"
            @change="updateConfig('search.providers.openclaw.enabled', $event.target.checked)"
          >
        </label>
        <label class="provider-field">
          <span>Base URL</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.openclaw?.baseUrl"
            placeholder="https://your-openclaw.example.com"
            @input="updateConfig('search.providers.openclaw.baseUrl', $event.target.value)"
          >
        </label>
        <label class="provider-field">
          <span>Endpoint</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.openclaw?.endpoint"
            placeholder="留空时自动拼接 /v1/chat/completions"
            @input="updateConfig('search.providers.openclaw.endpoint', $event.target.value)"
          >
        </label>
        <label class="provider-field">
          <span>API Key</span>
          <input
            class="input"
            type="password"
            :value="config.search?.providers?.openclaw?.apiKey"
            placeholder="如果网关需要鉴权就在这里填写"
            @input="updateConfig('search.providers.openclaw.apiKey', $event.target.value)"
          >
        </label>
        <label class="provider-field provider-field--full">
          <span>Model</span>
          <input
            class="input"
            type="text"
            :value="config.search?.providers?.openclaw?.model"
            placeholder="例如 gpt-4.1-mini / claude / qwen ..."
            @input="updateConfig('search.providers.openclaw.model', $event.target.value)"
          >
        </label>
      </div>
      <div class="provider-actions">
        <button class="btn btn--secondary" :disabled="providerTesting.openclaw" @click="handleProviderTest('openclaw')">
          {{ providerTesting.openclaw ? '测试中...' : '测试连接' }}
        </button>
      </div>
      <div
        v-if="providerMessages.openclaw"
        class="provider-message"
        :class="`is-${providerMessageTypes.openclaw}`"
      >
        {{ providerMessages.openclaw }}
      </div>
    </div>

    <div v-if="showAddModal" class="modal-overlay" @click.self="showAddModal = false">
      <div class="modal-content">
        <div class="modal__header">
          <h3>{{ editingEngine ? '编辑搜索引擎' : '添加搜索引擎' }}</h3>
          <button class="modal__close" type="button" aria-label="关闭" @click="showAddModal = false">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <div class="modal__body">
          <div class="form-group">
            <label class="form-label">名称</label>
            <input v-model="formData.name" type="text" class="input" placeholder="搜索引擎名称">
          </div>
          <div class="form-group">
            <label class="form-label">图标</label>
            <input v-model="formData.icon" type="text" class="input" placeholder="例如 G 或 AI">
          </div>
          <div class="form-group">
            <label class="form-label">搜索 URL</label>
            <input v-model="formData.url" type="text" class="input" placeholder="https://example.com/search?q=">
          </div>
        </div>
        <div class="modal__footer">
          <button class="btn btn--secondary" @click="showAddModal = false">取消</button>
          <button class="btn btn--primary" @click="saveEngine">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-section {
  margin-bottom: 24px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.settings-section__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-light);
}

.settings-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-light);
}

.settings-item--stack {
  display: block;
}

.settings-item:last-child {
  border-bottom: none;
}

.settings-item__info {
  flex: 1;
  padding-right: 20px;
}

.settings-item__label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.settings-item__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.6;
}

.engine-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  width: 360px;
}

.engine-option {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 6px;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.engine-option.is-active {
  background: var(--accent-bg);
  box-shadow: 0 0 0 2px var(--accent-color);
}

.engine-option__icon {
  font-size: 20px;
  margin-bottom: 4px;
}

.engine-option__name {
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
}

.engine-option__actions {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 4px;
}

.engine-option--add {
  border: 2px dashed var(--border-color);
  background: transparent;
}

.checkbox-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 999px;
  cursor: pointer;
  color: var(--text-primary);
}

.checkbox-item.is-checked {
  background: var(--accent-bg);
}

.checkbox-item input {
  display: none;
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.provider-field {
  display: grid;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.provider-field--full {
  grid-column: 1 / -1;
}

.provider-field--toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.provider-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.provider-message {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.provider-message.is-success {
  color: #3f7a56;
}

.provider-message.is-error {
  color: #c84d4d;
}

.input {
  width: 100%;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
}

.toggle {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 26px;
}

.toggle input {
  display: none;
}

.toggle__slider {
  position: absolute;
  inset: 0;
  background: var(--bg-tertiary);
  border-radius: 13px;
}

.toggle__slider::before {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  background: #fff;
  border-radius: 50%;
  transition: all 0.2s;
}

.toggle input:checked + .toggle__slider {
  background: var(--accent-color);
}

.toggle input:checked + .toggle__slider::before {
  transform: translateX(22px);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  width: 420px;
  max-width: 90vw;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.modal__header,
.modal__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-light);
}

.modal__footer {
  border-top: 1px solid var(--border-light);
  border-bottom: none;
  justify-content: flex-end;
  gap: 8px;
}

.modal__body {
  padding: 18px 20px;
}

.form-group {
  margin-bottom: 14px;
}

.form-label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.action-btn,
.btn,
.modal__close {
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--secondary,
.action-btn,
.modal__close {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.action-btn--danger {
  background: color-mix(in srgb, var(--error-color) 16%, var(--bg-secondary));
}

@media (max-width: 760px) {
  .provider-grid,
  .engine-grid {
    grid-template-columns: repeat(2, 1fr);
    width: 100%;
  }

  .settings-item {
    flex-direction: column;
    gap: 12px;
  }
}
</style>
