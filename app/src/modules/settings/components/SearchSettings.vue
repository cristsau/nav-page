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
import {
  AI_MODEL_CATALOG_VERIFIED_AT,
  getChatModelOptions,
  resolveConfiguredChatApiMode
} from '@/shared/config/aiModels'
import { normalizeEngineMonogram } from '@/shared/utils/unifiedSearch'

const {
  config,
  updateConfig,
  persistConfigNow,
  getAllSearchEngines,
  loadCustomSearchEngines
} = useConfig()

const customEngines = ref([])
const showAddModal = ref(false)
const editingEngine = ref(null)
const isSavingEngine = ref(false)
const deletingEngineId = ref('')
const engineMessage = ref('')
const engineMessageType = ref('')
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

const providerApiKeyDrafts = ref({
  chatgpt: '',
  brave: '',
  openclaw: ''
})

const providerKeySaving = ref({
  chatgpt: false,
  brave: false,
  openclaw: false
})

const allEngines = computed(() => getAllSearchEngines())
const aggregateEnabled = computed(() => config.value.search?.aggregate?.enabled || false)
const quickAccessIds = computed(() => config.value.search?.quickAccessEngineIds || [])
const chatApiMode = computed(() => resolveConfiguredChatApiMode(
  config.value.search?.providers?.chatgpt
))
const chatUsesResponsesApi = computed(() => chatApiMode.value === 'responses')
const chatModelOptions = computed(() => getChatModelOptions(
  config.value.search?.providers?.chatgpt?.model
))

async function loadCustomEngines() {
  try {
    customEngines.value = shouldUseBackendSearchEngines()
      ? await fetchBackendCustomSearchEngines()
      : await getCustomEngines()
  } catch (error) {
    customEngines.value = []
    setEngineMessage('error', error.message || '自定义搜索引擎加载失败')
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
  setEngineMessage('', '')
  showAddModal.value = true
}

function editEngine(engine) {
  editingEngine.value = engine
  formData.value = { name: engine.name, icon: engine.icon, url: engine.url }
  setEngineMessage('', '')
  showAddModal.value = true
}

function setEngineMessage(type, message) {
  engineMessageType.value = type
  engineMessage.value = message
}

function isValidSearchUrl(value) {
  try {
    const candidate = String(value || '').replaceAll('{query}', 'domo')
    const parsed = new URL(candidate)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

async function saveEngine() {
  const payload = {
    name: formData.value.name.trim(),
    icon: normalizeEngineMonogram(formData.value.icon),
    url: formData.value.url.trim()
  }

  if (!payload.name || !payload.url) {
    setEngineMessage('error', '请填写名称和搜索 URL')
    return
  }

  if (!isValidSearchUrl(payload.url)) {
    setEngineMessage('error', '搜索 URL 必须是有效的 HTTP 或 HTTPS 地址')
    return
  }

  isSavingEngine.value = true
  setEngineMessage('', '')

  try {
    if (editingEngine.value) {
      if (shouldUseBackendSearchEngines()) {
        await updateBackendCustomSearchEngine(editingEngine.value.id, payload)
      } else {
        await updateCustomEngine(editingEngine.value.id, payload)
      }
    } else if (shouldUseBackendSearchEngines()) {
      await createBackendCustomSearchEngine(payload)
    } else {
      await addCustomEngine(payload)
    }

    showAddModal.value = false
    await loadCustomEngines()
    await loadCustomSearchEngines()
    setEngineMessage('success', editingEngine.value ? '搜索引擎已更新' : '搜索引擎已添加')
  } catch (error) {
    setEngineMessage('error', error.message || '搜索引擎保存失败')
  } finally {
    isSavingEngine.value = false
  }
}

async function removeEngine(engine) {
  if (!confirm(`确定删除 ${engine.name} 吗？`)) return
  if (deletingEngineId.value) return

  deletingEngineId.value = engine.id
  setEngineMessage('', '')

  try {
    if (shouldUseBackendSearchEngines()) {
      await deleteBackendCustomSearchEngine(engine.id)
    } else {
      await deleteCustomEngine(engine.id)
    }

    if (config.value.searchEngine === engine.id) {
      updateConfig('searchEngine', 'baidu')
    }

    updateConfig(
      'search.quickAccessEngineIds',
      quickAccessIds.value.filter((engineId) => engineId !== engine.id)
    )
    updateConfig(
      'search.aggregate.engines',
      (config.value.search?.aggregate?.engines || []).filter((engineId) => engineId !== engine.id)
    )

    await loadCustomEngines()
    await loadCustomSearchEngines()
    setEngineMessage('success', `已删除 ${engine.name}`)
  } catch (error) {
    setEngineMessage('error', error.message || '搜索引擎删除失败')
  } finally {
    deletingEngineId.value = ''
  }
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

function isProviderKeyConfigured(provider) {
  return Boolean(config.value.search?.providers?.[provider]?.apiKeyConfigured)
}

async function saveProviderApiKey(provider) {
  const apiKey = providerApiKeyDrafts.value[provider].trim()
  if (!apiKey) {
    setProviderMessage(provider, 'error', '请输入要保存的 API Key')
    return
  }

  providerKeySaving.value[provider] = true
  setProviderMessage(provider, '', '')

  try {
    updateConfig(`search.providers.${provider}.clearApiKey`, false)
    updateConfig(`search.providers.${provider}.apiKey`, apiKey)
    const saved = await persistConfigNow()
    if (!saved) throw new Error('密钥保存失败')
    updateConfig(`search.providers.${provider}.apiKey`, '')
    updateConfig(`search.providers.${provider}.apiKeyConfigured`, true)
    providerApiKeyDrafts.value[provider] = ''
    setProviderMessage(provider, 'success', '密钥已安全保存，页面不会回显密钥内容')
  } catch (error) {
    setProviderMessage(provider, 'error', error.message || '密钥保存失败')
  } finally {
    providerKeySaving.value[provider] = false
  }
}

async function clearProviderApiKey(provider) {
  if (!confirm('确定清除已保存的 API Key 吗？清除后相关 AI 功能会停止工作。')) return

  providerKeySaving.value[provider] = true
  setProviderMessage(provider, '', '')

  try {
    providerApiKeyDrafts.value[provider] = ''
    updateConfig(`search.providers.${provider}.apiKey`, '')
    updateConfig(`search.providers.${provider}.clearApiKey`, true)
    const saved = await persistConfigNow()
    if (!saved) throw new Error('密钥清除失败')
    updateConfig(`search.providers.${provider}.clearApiKey`, false)
    updateConfig(`search.providers.${provider}.apiKeyConfigured`, false)
    setProviderMessage(provider, 'success', '已清除保存的密钥')
  } catch (error) {
    setProviderMessage(provider, 'error', error.message || '密钥清除失败')
  } finally {
    providerKeySaving.value[provider] = false
  }
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
    const providerConfig = {
      ...(config.value.search?.providers?.[provider] || {}),
      apiKey: providerApiKeyDrafts.value[provider].trim()
    }
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
          <article
            v-for="engine in allEngines"
            :key="engine.id"
            class="engine-option"
            :class="{ 'is-active': config.searchEngine === engine.id }"
          >
            <button
              class="engine-option__select"
              type="button"
              :aria-pressed="config.searchEngine === engine.id"
              :aria-label="`设为默认搜索引擎：${engine.name}`"
              @click="selectEngine(engine.id)"
            >
              <span class="engine-option__icon">{{ engine.icon }}</span>
              <span class="engine-option__name">{{ engine.name }}</span>
              <span v-if="config.searchEngine === engine.id" class="engine-option__selected">
                <Icon name="check" :size="13" />
                默认
              </span>
            </button>
            <div v-if="!engine.isBuiltIn" class="engine-option__actions">
              <button
                class="action-btn"
                type="button"
                :aria-label="`编辑 ${engine.name}`"
                title="编辑"
                :disabled="Boolean(deletingEngineId)"
                @click="editEngine(engine)"
              >
                <Icon name="edit" :size="15" />
              </button>
              <button
                class="action-btn action-btn--danger"
                type="button"
                :aria-label="`删除 ${engine.name}`"
                :title="deletingEngineId === engine.id ? '正在删除' : '删除'"
                :disabled="Boolean(deletingEngineId)"
                @click="removeEngine(engine)"
              >
                <Icon :name="deletingEngineId === engine.id ? 'refresh' : 'trash'" :size="15" />
              </button>
            </div>
          </article>
          <button class="engine-option engine-option--add" type="button" @click="openAddModal">
            <span class="engine-option__add-icon"><Icon name="plus" :size="18" /></span>
            <span class="engine-option__name">添加搜索引擎</span>
          </button>
        </div>
        <div
          v-if="engineMessage"
          class="engine-message"
          :class="`is-${engineMessageType}`"
          role="status"
        >
          <Icon :name="engineMessageType === 'success' ? 'circle-check' : 'alert'" :size="16" />
          <span>{{ engineMessage }}</span>
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
            :value="chatApiMode"
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
        <div class="provider-field provider-field--full">
          <div class="provider-key__label">
            <span>API Key</span>
            <span
              class="provider-key__status"
              :class="{ 'is-configured': isProviderKeyConfigured('chatgpt') }"
            >
              {{ isProviderKeyConfigured('chatgpt') ? '已安全保存' : '未配置' }}
            </span>
          </div>
          <div class="provider-key__row">
            <input
              v-model="providerApiKeyDrafts.chatgpt"
              class="input"
              type="password"
              autocomplete="new-password"
              :placeholder="isProviderKeyConfigured('chatgpt') ? '留空将继续使用已保存密钥' : '输入 API Key'"
              @keydown.enter="saveProviderApiKey('chatgpt')"
            >
            <button
              class="btn btn--secondary"
              type="button"
              :disabled="providerKeySaving.chatgpt || !providerApiKeyDrafts.chatgpt.trim()"
              @click="saveProviderApiKey('chatgpt')"
            >
              <Icon name="lock" :size="15" />
              保存密钥
            </button>
            <button
              v-if="isProviderKeyConfigured('chatgpt')"
              class="btn btn--danger-quiet"
              type="button"
              :disabled="providerKeySaving.chatgpt"
              @click="clearProviderApiKey('chatgpt')"
            >
              清除
            </button>
          </div>
          <span class="provider-key__hint">服务端只返回“已配置”状态，不会把密钥内容回传到浏览器。</span>
        </div>
        <label class="provider-field">
          <span>Model</span>
          <select
            class="input"
            :value="config.search?.providers?.chatgpt?.model"
            @change="updateConfig('search.providers.chatgpt.model', $event.target.value)"
          >
            <option
              v-for="model in chatModelOptions"
              :key="model.id"
              :value="model.id"
            >
              {{ model.id }} · {{ model.description }}
            </option>
          </select>
          <span class="provider-key__hint">
            依据当前生产验收与代理配置，最多显示 6 个；核验于 {{ AI_MODEL_CATALOG_VERIFIED_AT }}。
          </span>
        </label>
        <label class="provider-field" :class="{ 'is-disabled': !chatUsesResponsesApi }">
          <span>推理强度</span>
          <select
            class="input"
            :value="config.search?.providers?.chatgpt?.reasoningEffort || 'low'"
            :disabled="!chatUsesResponsesApi"
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
        <label
          class="provider-field provider-field--toggle"
          :class="{ 'is-disabled': !chatUsesResponsesApi }"
        >
          <span>联网搜索</span>
          <input
            type="checkbox"
            :checked="config.search?.providers?.chatgpt?.webSearchEnabled !== false"
            :disabled="!chatUsesResponsesApi"
            @change="updateConfig('search.providers.chatgpt.webSearchEnabled', $event.target.checked)"
          >
        </label>
        <p v-if="!chatUsesResponsesApi" class="provider-grid__notice">
          <Icon name="alert" :size="15" />
          当前为 Chat Completions 兼容网关，推理强度和内置联网搜索参数不会发送。
        </p>
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
        <div class="provider-field provider-field--full">
          <div class="provider-key__label">
            <span>API Key</span>
            <span
              class="provider-key__status"
              :class="{ 'is-configured': isProviderKeyConfigured('brave') }"
            >
              {{ isProviderKeyConfigured('brave') ? '已安全保存' : '未配置' }}
            </span>
          </div>
          <div class="provider-key__row">
            <input
              v-model="providerApiKeyDrafts.brave"
              class="input"
              type="password"
              autocomplete="new-password"
              :placeholder="isProviderKeyConfigured('brave') ? '留空将继续使用已保存密钥' : '输入 Brave Search API Key'"
              @keydown.enter="saveProviderApiKey('brave')"
            >
            <button
              class="btn btn--secondary"
              type="button"
              :disabled="providerKeySaving.brave || !providerApiKeyDrafts.brave.trim()"
              @click="saveProviderApiKey('brave')"
            >
              <Icon name="lock" :size="15" />
              保存密钥
            </button>
            <button
              v-if="isProviderKeyConfigured('brave')"
              class="btn btn--danger-quiet"
              type="button"
              :disabled="providerKeySaving.brave"
              @click="clearProviderApiKey('brave')"
            >
              清除
            </button>
          </div>
          <span class="provider-key__hint">留空测试时会使用服务端已保存密钥。</span>
        </div>
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
        <div class="provider-field provider-field--full">
          <div class="provider-key__label">
            <span>API Key</span>
            <span
              class="provider-key__status"
              :class="{ 'is-configured': isProviderKeyConfigured('openclaw') }"
            >
              {{ isProviderKeyConfigured('openclaw') ? '已安全保存' : '未配置' }}
            </span>
          </div>
          <div class="provider-key__row">
            <input
              v-model="providerApiKeyDrafts.openclaw"
              class="input"
              type="password"
              autocomplete="new-password"
              :placeholder="isProviderKeyConfigured('openclaw') ? '留空将继续使用已保存密钥' : '网关需要鉴权时填写'"
              @keydown.enter="saveProviderApiKey('openclaw')"
            >
            <button
              class="btn btn--secondary"
              type="button"
              :disabled="providerKeySaving.openclaw || !providerApiKeyDrafts.openclaw.trim()"
              @click="saveProviderApiKey('openclaw')"
            >
              <Icon name="lock" :size="15" />
              保存密钥
            </button>
            <button
              v-if="isProviderKeyConfigured('openclaw')"
              class="btn btn--danger-quiet"
              type="button"
              :disabled="providerKeySaving.openclaw"
              @click="clearProviderApiKey('openclaw')"
            >
              清除
            </button>
          </div>
          <span class="provider-key__hint">OpenClaw 不需要鉴权时可保持未配置。</span>
        </div>
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
            <label class="form-label">字母简称</label>
            <input
              v-model="formData.icon"
              type="text"
              class="input"
              maxlength="2"
              placeholder="例如 G 或 AI"
            >
            <p class="form-hint">使用 1–2 个字母或数字；其他符号会在保存时自动移除。</p>
          </div>
          <div class="form-group">
            <label class="form-label">搜索 URL</label>
            <input
              v-model="formData.url"
              type="url"
              class="input"
              placeholder="https://example.com/search?q={query}"
              @keydown.enter="saveEngine"
            >
            <p class="form-hint">支持在 URL 中使用 <code>{query}</code>；未使用时会把关键词追加到末尾。</p>
          </div>
          <div
            v-if="engineMessage && showAddModal"
            class="engine-message"
            :class="`is-${engineMessageType}`"
            role="alert"
          >
            <Icon :name="engineMessageType === 'success' ? 'circle-check' : 'alert'" :size="16" />
            <span>{{ engineMessage }}</span>
          </div>
        </div>
        <div class="modal__footer">
          <button class="btn btn--secondary" type="button" :disabled="isSavingEngine" @click="showAddModal = false">取消</button>
          <button class="btn btn--primary" type="button" :disabled="isSavingEngine" @click="saveEngine">
            <Icon :name="isSavingEngine ? 'refresh' : 'check'" :size="16" />
            {{ isSavingEngine ? '保存中' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-section {
  scroll-margin-top: 104px;
}

.settings-section:focus {
  outline: none;
}

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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  width: min(100%, 500px);
}

.engine-option {
  position: relative;
  min-width: 0;
  min-height: 74px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  padding: 6px;
  background: color-mix(in srgb, var(--bg-secondary) 88%, var(--bg-card));
  border: 1px solid var(--border-light);
  border-radius: 18px;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

.engine-option.is-active {
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--accent-color) 46%, var(--border-light));
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent-color) 10%, transparent);
}

.engine-option:hover {
  border-color: color-mix(in srgb, var(--accent-color) 30%, var(--border-light));
  transform: translateY(-1px);
}

.engine-option__select {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 10px;
  row-gap: 3px;
  padding: 7px 8px;
  border: 0;
  border-radius: 13px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.engine-option__icon {
  grid-row: 1 / -1;
  display: inline-grid;
  place-items: center;
  min-width: 36px;
  height: 36px;
  padding: 0 7px;
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--accent-color);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.02em;
  box-shadow: inset 0 0 0 1px var(--border-light);
}

.engine-option__name {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-option__selected {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 650;
}

.engine-option__actions {
  display: grid;
  align-content: center;
  gap: 5px;
  padding-left: 5px;
  border-left: 1px solid color-mix(in srgb, var(--border-light) 76%, transparent);
}

.engine-option--add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 1px dashed var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.engine-option__add-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: var(--bg-secondary);
  color: var(--accent-color);
}

.engine-message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: min(100%, 500px);
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 13px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.engine-message.is-success {
  color: var(--success-color);
}

.engine-message.is-error {
  color: var(--error-color);
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

.provider-field.is-disabled {
  opacity: 0.58;
}

.provider-grid__notice {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--warning-color) 8%, var(--bg-secondary));
  border-radius: var(--radius-md);
  font-size: 11px;
  line-height: 1.55;
}

.provider-grid__notice .app-icon {
  margin-top: 1px;
}

.provider-key__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.provider-key__status {
  display: inline-flex;
  align-items: center;
  min-height: 23px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 650;
}

.provider-key__status.is-configured {
  background: color-mix(in srgb, var(--success-color) 14%, var(--bg-secondary));
  color: var(--success-color);
}

.provider-key__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}

.provider-key__hint {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
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

.form-hint {
  margin: 7px 2px 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.form-hint code {
  padding: 2px 5px;
  border-radius: 5px;
  background: var(--bg-secondary);
  color: var(--accent-color);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
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

.btn:disabled,
.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 10px;
}

.action-btn:hover:not(:disabled) {
  border-color: var(--border-color);
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--danger-quiet {
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  color: var(--error-color);
}

.btn--secondary,
.action-btn,
.modal__close {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.action-btn--danger {
  background: color-mix(in srgb, var(--error-color) 16%, var(--bg-secondary));
  color: var(--error-color);
}

.action-btn--danger svg,
.btn svg[name='refresh'] {
  animation: none;
}

.action-btn--danger:disabled svg,
.btn:disabled svg {
  animation: engine-spin 0.9s linear infinite;
}

@keyframes engine-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 760px) {
  .provider-grid {
    grid-template-columns: repeat(2, 1fr);
    width: 100%;
  }

  .engine-grid {
    width: 100%;
  }

  .settings-item {
    flex-direction: column;
    gap: 12px;
  }
}

@media (max-width: 520px) {
  .provider-grid,
  .engine-grid {
    grid-template-columns: 1fr;
  }

  .provider-key__row {
    grid-template-columns: 1fr 1fr;
  }

  .provider-key__row .input {
    grid-column: 1 / -1;
  }
}
</style>
