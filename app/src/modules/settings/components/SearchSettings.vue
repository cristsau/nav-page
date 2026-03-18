<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useConfig, searchEngines } from '@/shared/composables/useConfig'
import { getCustomEngines, addCustomEngine, updateCustomEngine, deleteCustomEngine } from '@/shared/db/database'

const { config, updateConfig } = useConfig()

// 内置搜索引擎列表
const builtInEngines = Object.entries(searchEngines).map(([key, value]) => ({
  id: key,
  ...value,
  isBuiltIn: true
}))

// 自定义搜索引擎
const customEngines = ref([])

// 所有搜索引擎
const allEngines = computed(() => [...builtInEngines, ...customEngines.value])

// 聚合搜索设置
const aggregateEnabled = computed(() => config.value.search?.aggregate?.enabled || false)
const aggregateEngines = computed(() => config.value.search?.aggregate?.engines || [])

// 显示添加引擎弹窗
const showAddModal = ref(false)
const editingEngine = ref(null)

// 表单数据
const formData = ref({
  name: '',
  icon: '🔍',
  url: ''
})

// 加载自定义搜索引擎
async function loadCustomEngines() {
  try {
    customEngines.value = await getCustomEngines()
  } catch (e) {
    customEngines.value = []
  }
}

onMounted(() => {
  loadCustomEngines()
})

// 选择搜索引擎
function selectEngine(engineId) {
  updateConfig('searchEngine', engineId)
}

// 打开添加弹窗
function openAddModal() {
  editingEngine.value = null
  formData.value = { name: '', icon: '🔍', url: '' }
  showAddModal.value = true
}

// 编辑自定义引擎
function editEngine(engine) {
  editingEngine.value = engine
  formData.value = { name: engine.name, icon: engine.icon, url: engine.url }
  showAddModal.value = true
}

// 保存自定义引擎
async function saveEngine() {
  if (!formData.value.name || !formData.value.url) {
    alert('请填写名称和URL')
    return
  }

  if (editingEngine.value) {
    await updateCustomEngine(editingEngine.value.id, formData.value)
  } else {
    await addCustomEngine(formData.value)
  }

  showAddModal.value = false
  await loadCustomEngines()
}

// 删除自定义引擎
async function deleteEngine(engine) {
  if (!confirm(`确定删除「${engine.name}」？`)) return
  await deleteCustomEngine(engine.id)
  await loadCustomEngines()
}

// 切换聚合搜索
function toggleAggregate() {
  const currentEngines = config.value.search?.aggregate?.engines || []
  updateConfig('search.aggregate', {
    enabled: !aggregateEnabled.value,
    engines: currentEngines
  })
}

// 切换聚合引擎
function toggleAggregateEngine(engineId) {
  const engines = [...(config.value.search?.aggregate?.engines || [])]
  const index = engines.indexOf(engineId)

  if (index > -1) {
    engines.splice(index, 1)
  } else {
    engines.push(engineId)
  }

  updateConfig('search.aggregate', {
    enabled: aggregateEnabled.value,
    engines
  })
}

// 检查引擎是否在聚合列表中
function isAggregateEngine(engineId) {
  return (config.value.search?.aggregate?.engines || []).includes(engineId)
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">🔍 搜索设置</h3>

    <!-- 默认搜索引擎 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">默认搜索引擎</div>
        <div class="settings-item__desc">选择搜索时使用的引擎</div>
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
            <span v-if="!engine.isBuiltIn" class="engine-option__badge">自定义</span>
            <div v-if="!engine.isBuiltIn" class="engine-option__actions" @click.stop>
              <button class="action-btn" @click="editEngine(engine)">✏️</button>
              <button class="action-btn action-btn--danger" @click="deleteEngine(engine)">🗑️</button>
            </div>
          </button>
          <button class="engine-option engine-option--add" @click="openAddModal">
            <span class="engine-option__icon">➕</span>
            <span class="engine-option__name">添加</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 聚合搜索 -->
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

    <!-- 聚合引擎选择 -->
    <div v-if="aggregateEnabled" class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">选择聚合引擎</div>
        <div class="settings-item__desc">勾选要同时搜索的引擎（至少选2个）</div>
      </div>
      <div class="settings-item__control">
        <div class="checkbox-grid">
          <label
            v-for="engine in allEngines"
            :key="engine.id"
            class="checkbox-item"
            :class="{ 'is-checked': isAggregateEngine(engine.id) }"
          >
            <input
              type="checkbox"
              :checked="isAggregateEngine(engine.id)"
              @change="toggleAggregateEngine(engine.id)"
            >
            <span class="checkbox-item__icon">{{ engine.icon }}</span>
            <span class="checkbox-item__label">{{ engine.name }}</span>
          </label>
        </div>
      </div>
    </div>

    <!-- 添加/编辑弹窗 -->
    <div v-if="showAddModal" class="modal-overlay" @click.self="showAddModal = false">
      <div class="modal-content">
        <div class="modal__header">
          <h3>{{ editingEngine ? '编辑搜索引擎' : '添加搜索引擎' }}</h3>
          <button class="modal__close" @click="showAddModal = false">✕</button>
        </div>
        <div class="modal__body">
          <div class="form-group">
            <label class="form-label">名称</label>
            <input v-model="formData.name" type="text" class="input" placeholder="搜索引擎名称">
          </div>
          <div class="form-group">
            <label class="form-label">图标（emoji）</label>
            <input v-model="formData.icon" type="text" class="input" placeholder="🔍">
          </div>
          <div class="form-group">
            <label class="form-label">搜索URL</label>
            <input v-model="formData.url" type="text" class="input" placeholder="https://example.com/search?q=">
            <p class="form-hint">搜索词会自动拼接到URL末尾</p>
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

.settings-item__control {
  flex-shrink: 0;
}

/* 搜索引擎网格 */
.engine-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  width: 300px;
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
  transition: all 0.2s;
}

.engine-option:hover {
  background: var(--bg-hover);
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
}

.engine-option__badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 9px;
  padding: 1px 4px;
  background: var(--accent-color);
  color: #fff;
  border-radius: 4px;
}

.engine-option__actions {
  position: absolute;
  top: 2px;
  right: 2px;
  display: none;
  gap: 2px;
}

.engine-option:hover .engine-option__actions {
  display: flex;
}

.engine-option--add {
  border: 2px dashed var(--border-color);
  background: transparent;
}

.engine-option--add:hover {
  border-color: var(--accent-color);
}

.action-btn {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-card);
  border: none;
  border-radius: 4px;
  font-size: 10px;
  cursor: pointer;
}

.action-btn--danger:hover {
  background: var(--error-color);
  color: #fff;
}

/* 开关 */
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
  cursor: pointer;
  transition: all 0.2s;
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
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.toggle input:checked + .toggle__slider {
  background: var(--accent-color);
}

.toggle input:checked + .toggle__slider::before {
  transform: translateX(22px);
}

/* 复选框网格 */
.checkbox-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 300px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  background: var(--bg-secondary);
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s;
}

.checkbox-item:hover {
  background: var(--bg-hover);
}

.checkbox-item.is-checked {
  background: var(--accent-bg);
}

.checkbox-item input {
  display: none;
}

.checkbox-item__icon {
  font-size: 12px;
}

.checkbox-item__label {
  font-size: 11px;
  color: var(--text-secondary);
}

/* 弹窗 */
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
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 400px;
  max-width: 90vw;
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-light);
}

.modal__header h3 {
  font-size: 16px;
  color: var(--text-primary);
}

.modal__close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.modal__body {
  padding: 20px;
}

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-light);
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.input {
  width: 100%;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  outline: none;
}

.input:focus {
  border-color: var(--accent-color);
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

@media (max-width: 640px) {
  .settings-item {
    flex-direction: column;
    gap: 12px;
  }

  .settings-item__info {
    padding-right: 0;
  }

  .settings-item__control {
    width: 100%;
  }

  .engine-grid,
  .checkbox-grid {
    width: 100%;
  }
}
</style>
