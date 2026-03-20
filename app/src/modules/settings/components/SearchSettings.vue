<script setup>
import { ref, computed, onMounted } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'
import { getCustomEngines, addCustomEngine, updateCustomEngine, deleteCustomEngine } from '@/shared/db/database'

const { config, updateConfig, getAllSearchEngines, loadCustomSearchEngines } = useConfig()

const customEngines = ref([])
const showAddModal = ref(false)
const editingEngine = ref(null)
const formData = ref({
  name: '',
  icon: '🔎',
  url: ''
})

const allEngines = computed(() => getAllSearchEngines())
const aggregateEnabled = computed(() => config.value.search?.aggregate?.enabled || false)
const quickAccessIds = computed(() => config.value.search?.quickAccessEngineIds || [])

async function loadCustomEngines() {
  try {
    customEngines.value = await getCustomEngines()
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
  formData.value = { name: '', icon: '🔎', url: '' }
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
    await updateCustomEngine(editingEngine.value.id, formData.value)
  } else {
    await addCustomEngine(formData.value)
  }

  showAddModal.value = false
  await loadCustomEngines()
  await loadCustomSearchEngines()
}

async function removeEngine(engine) {
  if (!confirm(`确定删除 ${engine.name} 吗？`)) return
  await deleteCustomEngine(engine.id)
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
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">搜索设置</h3>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">默认搜索引擎</div>
        <div class="settings-item__desc">支持百度、Google、Bing、Brave 和 ChatGPT Search</div>
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
              <button class="action-btn" @click="editEngine(engine)">✏️</button>
              <button class="action-btn action-btn--danger" @click="removeEngine(engine)">🗑</button>
            </div>
          </button>
          <button class="engine-option engine-option--add" @click="openAddModal">
            <span class="engine-option__icon">＋</span>
            <span class="engine-option__name">添加</span>
          </button>
        </div>
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">前台快速切换引擎</div>
        <div class="settings-item__desc">这里勾选的引擎才会出现在首页搜索框的切换菜单里</div>
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
        <div class="settings-item__desc">一次搜索同时打开多个引擎</div>
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
        <div class="settings-item__desc">勾选要一起打开的搜索引擎</div>
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
        <div class="settings-item__label">ChatGPT Search 接入</div>
        <div class="settings-item__desc">支持 CLI Proxy / API 方式保存配置。目前前台先做接入入口和回退打开 ChatGPT。</div>
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
            <option value="api">OpenAI API</option>
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
            placeholder="https://api.openai.com/v1/..."
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
            placeholder="gpt-4.1 / gpt-5..."
            @input="updateConfig('search.providers.chatgpt.model', $event.target.value)"
          >
        </label>
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">Brave Search API 接入</div>
        <div class="settings-item__desc">可先保存接口配置，后续我们再把前台 AI 搜索结果面板接上</div>
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
            @input="updateConfig('search.providers.brave.endpoint', $event.target.value)"
          >
        </label>
        <label class="provider-field">
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
    </div>

    <div v-if="showAddModal" class="modal-overlay" @click.self="showAddModal = false">
      <div class="modal-content">
        <div class="modal__header">
          <h3>{{ editingEngine ? '编辑搜索引擎' : '添加搜索引擎' }}</h3>
          <button class="modal__close" @click="showAddModal = false">×</button>
        </div>
        <div class="modal__body">
          <div class="form-group">
            <label class="form-label">名称</label>
            <input v-model="formData.name" type="text" class="input" placeholder="搜索引擎名称">
          </div>
          <div class="form-group">
            <label class="form-label">图标</label>
            <input v-model="formData.icon" type="text" class="input" placeholder="🔎">
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
