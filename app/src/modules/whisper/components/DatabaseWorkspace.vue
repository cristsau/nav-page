<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import {
  archiveWorkspaceDatabaseRow,
  createWorkspaceDatabase,
  createWorkspaceDatabaseProperty,
  createWorkspaceDatabaseRow,
  createWorkspaceDatabaseView,
  deleteWorkspaceDatabaseProperty,
  fetchWorkspaceDatabaseRows,
  fetchWorkspaceDatabases,
  restoreWorkspaceDatabaseRow,
  updateWorkspaceDatabaseRow,
  updateWorkspaceDatabaseView
} from '@/shared/services/workspaceDatabasesApi'

const emit = defineEmits(['status'])

const databases = ref([])
const activeDatabaseId = ref('')
const database = ref(null)
const properties = ref([])
const views = ref([])
const rows = ref([])
const backlinksByRow = ref({})
const activeViewId = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const showDatabaseModal = ref(false)
const showPropertyModal = ref(false)
const showViewModal = ref(false)
const showViewSettings = ref(false)
const showRowModal = ref(false)
const showArchived = ref(false)
const editingRow = ref(null)
const relationChoices = ref({})

const databaseDraft = ref({ name: '', description: '', template: 'project' })
const propertyDraft = ref({ name: '', type: 'text', options: '', targetDatabaseId: '' })
const viewDraft = ref({ name: '', type: 'table', groupByPropertyId: '' })
const rowDraft = ref({ title: '', values: {} })
const viewConfigDraft = ref({ filters: [], sorts: [], visiblePropertyIds: [], groupByPropertyId: '' })

const filterOperatorOptions = Object.freeze({
  title: [['contains', '包含'], ['not_contains', '不包含'], ['equals', '等于'], ['not_equals', '不等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  text: [['contains', '包含'], ['not_contains', '不包含'], ['equals', '等于'], ['not_equals', '不等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  number: [['equals', '等于'], ['not_equals', '不等于'], ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  select: [['equals', '等于'], ['not_equals', '不等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  multi_select: [['contains', '包含'], ['not_contains', '不包含'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  status: [['equals', '等于'], ['not_equals', '不等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  date: [['before', '早于'], ['after', '晚于'], ['equals', '等于'], ['not_equals', '不等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  checkbox: [['equals', '等于'], ['not_equals', '不等于']],
  url: [['contains', '包含'], ['not_contains', '不包含'], ['equals', '等于'], ['not_equals', '不等于'], ['is_empty', '为空'], ['is_not_empty', '不为空']],
  relation: [['contains', '包含'], ['not_contains', '不包含'], ['is_empty', '为空'], ['is_not_empty', '不为空']]
})

const activeView = computed(() => views.value.find((view) => view.id === activeViewId.value) || views.value[0] || null)
const visibleProperties = computed(() => {
  const configured = activeView.value?.config?.visiblePropertyIds || []
  if (!configured.length) return properties.value
  const allowed = new Set(configured)
  return properties.value.filter((property) => allowed.has(property.id))
})
const boardProperty = computed(() => {
  const requested = activeView.value?.config?.groupByPropertyId
  return properties.value.find((property) => property.id === requested)
    || properties.value.find((property) => ['status', 'select'].includes(property.type))
    || null
})
const boardGroups = computed(() => {
  const property = boardProperty.value
  if (!property) return [{ id: '__all', name: '全部记录', rows: rows.value }]
  const options = property.config?.options || []
  const groups = [
    { id: '__empty', name: '未分组', rows: [] },
    ...options.map((option) => ({ id: option.id, name: option.name, color: option.color, rows: [] }))
  ]
  for (const row of rows.value.filter((item) => !item.archived)) {
    const value = row.values?.[property.id]
    const group = groups.find((item) => item.id === value) || groups[0]
    group.rows.push(row)
  }
  return groups
})

function setStatus(message, type = 'success') {
  emit('status', { message, type })
}

function optionFor(property, value) {
  return (property.config?.options || []).find((option) => option.id === value)
}

function filterProperty(filter) {
  return properties.value.find((property) => property.id === filter.propertyId) || properties.value[0] || null
}

function filterOperators(filter) {
  return filterOperatorOptions[filterProperty(filter)?.type] || filterOperatorOptions.text
}

function resetFilter(filter) {
  const property = filterProperty(filter)
  const [operator = 'equals'] = filterOperatorOptions[property?.type]?.[0] || []
  filter.operator = operator
  filter.value = property?.type === 'checkbox' ? true : ''
}

function toLocalDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function relationTitle(id) {
  for (const choices of Object.values(relationChoices.value)) {
    const row = choices.find((item) => item.id === id)
    if (row) return row.title
  }
  return `记录 ${String(id).slice(0, 8)}`
}

function displayValue(row, property) {
  if (property.type === 'title') return row.title
  const value = row.values?.[property.id]
  if (value === null || value === undefined || value === '') return '—'
  if (property.type === 'checkbox') return value ? '是' : '否'
  if (property.type === 'date') return new Date(value).toLocaleString('zh-CN')
  if (property.type === 'select' || property.type === 'status') return optionFor(property, value)?.name || '未知选项'
  if (property.type === 'multi_select') return value.map((id) => optionFor(property, id)?.name || '未知选项').join('、') || '—'
  if (property.type === 'relation') return value.map(relationTitle).join('、') || '—'
  return String(value)
}

async function loadDatabases({ selectFirst = true } = {}) {
  loading.value = true
  error.value = ''
  try {
    databases.value = await fetchWorkspaceDatabases()
    if (selectFirst && !activeDatabaseId.value && databases.value.length) {
      await selectDatabase(databases.value[0].id)
    } else if (!databases.value.length) {
      database.value = null
      properties.value = []
      views.value = []
      rows.value = []
    }
  } catch (cause) {
    error.value = cause.message || '数据库工作区加载失败'
  } finally {
    loading.value = false
  }
}

async function selectDatabase(databaseId) {
  activeDatabaseId.value = databaseId
  loading.value = true
  error.value = ''
  try {
    const payload = await fetchWorkspaceDatabaseRows(databaseId, {
      includeArchived: showArchived.value
    })
    database.value = payload.database
    properties.value = payload.properties || []
    views.value = payload.views || []
    activeViewId.value = payload.selectedViewId || views.value[0]?.id || ''
    rows.value = payload.rows || []
    backlinksByRow.value = payload.backlinksByRow || {}
    await loadRelationChoices()
  } catch (cause) {
    error.value = cause.message || '数据库加载失败'
  } finally {
    loading.value = false
  }
}

async function reloadRows(viewId = activeViewId.value) {
  if (!activeDatabaseId.value) return
  const payload = await fetchWorkspaceDatabaseRows(activeDatabaseId.value, {
    viewId,
    includeArchived: showArchived.value
  })
  database.value = payload.database
  properties.value = payload.properties || []
  views.value = payload.views || []
  activeViewId.value = payload.selectedViewId || viewId || views.value[0]?.id || ''
  rows.value = payload.rows || []
  backlinksByRow.value = payload.backlinksByRow || {}
}

async function chooseView(viewId) {
  loading.value = true
  try {
    await reloadRows(viewId)
  } catch (cause) {
    setStatus(cause.message || '视图加载失败', 'error')
  } finally {
    loading.value = false
  }
}

function databaseTemplateProperties(template) {
  if (template === 'blank') return [{ name: '名称', type: 'title', config: {} }]
  return [
    { name: '名称', type: 'title', config: {} },
    {
      name: '状态',
      type: 'status',
      config: {
        options: [
          { name: '待处理', color: 'gray' },
          { name: '进行中', color: 'blue' },
          { name: '已完成', color: 'green' }
        ]
      }
    },
    { name: '日期', type: 'date', config: { includeTime: false } },
    { name: '说明', type: 'text', config: {} }
  ]
}

async function saveDatabase() {
  if (!databaseDraft.value.name.trim()) return
  busy.value = true
  try {
    const properties = databaseTemplateProperties(databaseDraft.value.template)
    const statusIndex = properties.findIndex((property) => property.type === 'status')
    const payload = await createWorkspaceDatabase({
      name: databaseDraft.value.name,
      description: databaseDraft.value.description,
      icon: 'database',
      properties,
      views: statusIndex >= 0
        ? [
            { name: '表格', type: 'table', config: {} },
            { name: '看板', type: 'board', config: {} }
          ]
        : [{ name: '表格', type: 'table', config: {} }]
    })
    showDatabaseModal.value = false
    databaseDraft.value = { name: '', description: '', template: 'project' }
    await loadDatabases({ selectFirst: false })
    await selectDatabase(payload.database.id)
    setStatus('数据库已创建')
  } catch (cause) {
    setStatus(cause.message || '数据库创建失败', 'error')
  } finally {
    busy.value = false
  }
}

function propertyConfigFromDraft() {
  const type = propertyDraft.value.type
  if (['select', 'multi_select', 'status'].includes(type)) {
    const options = propertyDraft.value.options
      .split(/[,，\n]/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({
        name,
        color: ['gray', 'blue', 'green', 'yellow', 'red', 'purple'][index % 6]
      }))
    return { options }
  }
  if (type === 'relation') {
    return { targetDatabaseId: propertyDraft.value.targetDatabaseId, allowMultiple: true }
  }
  if (type === 'date') return { includeTime: true }
  if (type === 'number') return { format: 'number' }
  return {}
}

async function saveProperty() {
  busy.value = true
  try {
    await createWorkspaceDatabaseProperty(activeDatabaseId.value, {
      name: propertyDraft.value.name,
      type: propertyDraft.value.type,
      config: propertyConfigFromDraft()
    })
    showPropertyModal.value = false
    propertyDraft.value = { name: '', type: 'text', options: '', targetDatabaseId: '' }
    await reloadRows()
    await loadRelationChoices()
    setStatus('属性已添加')
  } catch (cause) {
    setStatus(cause.message || '属性添加失败', 'error')
  } finally {
    busy.value = false
  }
}

async function removeProperty(property) {
  if (property.type === 'title') return
  if (!window.confirm(`删除属性“${property.name}”及所有记录中的对应值？`)) return
  busy.value = true
  try {
    await deleteWorkspaceDatabaseProperty(activeDatabaseId.value, property.id)
    await reloadRows()
    setStatus('属性已删除')
  } catch (cause) {
    setStatus(cause.message || '属性删除失败', 'error')
  } finally {
    busy.value = false
  }
}

async function saveView() {
  busy.value = true
  try {
    const config = {
      filters: [],
      sorts: [],
      visiblePropertyIds: properties.value.map((property) => property.id),
      groupByPropertyId: viewDraft.value.type === 'board'
        ? (viewDraft.value.groupByPropertyId || null)
        : null
    }
    const payload = await createWorkspaceDatabaseView(activeDatabaseId.value, {
      name: viewDraft.value.name,
      type: viewDraft.value.type,
      config
    })
    showViewModal.value = false
    viewDraft.value = { name: '', type: 'table', groupByPropertyId: '' }
    await chooseView(payload.view.id)
    setStatus('视图已创建')
  } catch (cause) {
    setStatus(cause.message || '视图创建失败', 'error')
  } finally {
    busy.value = false
  }
}

async function openViewSettings() {
  await loadRelationChoices()
  const config = activeView.value?.config || {}
  viewConfigDraft.value = {
    filters: (config.filters || []).map((filter) => ({ ...filter })),
    sorts: (config.sorts || []).map((sort) => ({ ...sort })),
    visiblePropertyIds: [...(config.visiblePropertyIds || properties.value.map((property) => property.id))],
    groupByPropertyId: config.groupByPropertyId || ''
  }
  showViewSettings.value = true
}

function addFilter() {
  const propertyId = properties.value[0]?.id
  if (!propertyId) return
  const filter = { propertyId, operator: 'contains', value: '' }
  resetFilter(filter)
  viewConfigDraft.value.filters.push(filter)
}

function addSort() {
  const propertyId = properties.value[0]?.id
  if (!propertyId) return
  viewConfigDraft.value.sorts.push({ propertyId, direction: 'asc' })
}

async function saveViewSettings() {
  busy.value = true
  try {
    await updateWorkspaceDatabaseView(activeDatabaseId.value, activeViewId.value, {
      config: {
        filters: viewConfigDraft.value.filters.map((filter) => ({
          propertyId: filter.propertyId,
          operator: filter.operator,
          value: ['is_empty', 'is_not_empty'].includes(filter.operator) ? null : filter.value
        })),
        sorts: viewConfigDraft.value.sorts,
        visiblePropertyIds: viewConfigDraft.value.visiblePropertyIds,
        groupByPropertyId: activeView.value?.type === 'board'
          ? (viewConfigDraft.value.groupByPropertyId || null)
          : null
      }
    })
    showViewSettings.value = false
    await reloadRows(activeViewId.value)
    setStatus('视图筛选和排序已保存')
  } catch (cause) {
    setStatus(cause.message || '视图设置保存失败', 'error')
  } finally {
    busy.value = false
  }
}

async function loadRelationChoices() {
  const targets = [...new Set(properties.value
    .filter((property) => property.type === 'relation')
    .map((property) => property.config?.targetDatabaseId)
    .filter(Boolean))]
  const next = { ...relationChoices.value }
  for (const targetId of targets) {
    if (next[targetId]) continue
    try {
      const payload = await fetchWorkspaceDatabaseRows(targetId)
      next[targetId] = (payload.rows || []).filter((row) => !row.archived)
    } catch {
      next[targetId] = []
    }
  }
  relationChoices.value = next
}

async function openRow(row = null) {
  await loadRelationChoices()
  editingRow.value = row
  const values = structuredClone(row?.values || {})
  for (const property of properties.value) {
    if (property.type === 'checkbox' && values[property.id] === undefined) values[property.id] = false
    if (['multi_select', 'relation'].includes(property.type) && !Array.isArray(values[property.id])) values[property.id] = []
    if (property.type === 'date' && values[property.id]) values[property.id] = toLocalDateTime(values[property.id])
  }
  rowDraft.value = {
    title: row?.title || '',
    values
  }
  showRowModal.value = true
}

function normalizeFormValues(values) {
  const result = {}
  for (const property of properties.value) {
    if (property.type === 'title') continue
    const value = values[property.id]
    if (value === '' || value === null || value === undefined) continue
    if (property.type === 'number') result[property.id] = Number(value)
    else if (property.type === 'date') result[property.id] = new Date(value).toISOString()
    else result[property.id] = value
  }
  return result
}

async function saveRow() {
  if (!rowDraft.value.title.trim()) return
  busy.value = true
  try {
    const input = {
      title: rowDraft.value.title,
      values: normalizeFormValues(rowDraft.value.values)
    }
    if (editingRow.value) {
      await updateWorkspaceDatabaseRow(activeDatabaseId.value, editingRow.value.id, input)
    } else {
      await createWorkspaceDatabaseRow(activeDatabaseId.value, input)
    }
    showRowModal.value = false
    await reloadRows()
    setStatus(editingRow.value ? '记录已更新' : '记录已创建')
  } catch (cause) {
    setStatus(cause.message || '记录保存失败', 'error')
  } finally {
    busy.value = false
  }
}

async function archiveRow(row) {
  if (!window.confirm(`归档“${row.title}”？可在归档视图中恢复。`)) return
  busy.value = true
  try {
    await archiveWorkspaceDatabaseRow(activeDatabaseId.value, row.id)
    await reloadRows()
    setStatus('记录已归档')
  } catch (cause) {
    setStatus(cause.message || '记录归档失败', 'error')
  } finally {
    busy.value = false
  }
}

async function restoreRow(row) {
  busy.value = true
  try {
    await restoreWorkspaceDatabaseRow(activeDatabaseId.value, row.id)
    await reloadRows()
    setStatus('记录已恢复')
  } catch (cause) {
    setStatus(cause.message || '记录恢复失败', 'error')
  } finally {
    busy.value = false
  }
}

async function toggleArchived() {
  showArchived.value = !showArchived.value
  loading.value = true
  try {
    await reloadRows()
  } finally {
    loading.value = false
  }
}

onMounted(() => loadDatabases())
</script>

<template>
  <section class="database-workspace" aria-label="数据库工作区">
    <aside class="database-sidebar">
      <div class="database-sidebar__header">
        <div>
          <strong>数据库</strong>
          <small>表格、看板与关联资料</small>
        </div>
        <button type="button" aria-label="新建数据库" title="新建数据库" @click="showDatabaseModal = true">
          <Icon name="plus" :size="18" />
        </button>
      </div>
      <button
        v-for="item in databases"
        :key="item.id"
        type="button"
        class="database-sidebar__item"
        :class="{ 'is-active': item.id === activeDatabaseId }"
        @click="selectDatabase(item.id)"
      >
        <Icon name="database" :size="17" />
        <span><strong>{{ item.name }}</strong><small>{{ item.rowCount || 0 }} 条记录</small></span>
      </button>
      <div v-if="!databases.length && !loading" class="database-sidebar__empty">尚未创建数据库</div>
    </aside>

    <div class="database-main">
      <div v-if="loading" class="database-state" role="status"><Icon name="refresh" :size="20" />正在加载数据库…</div>
      <div v-else-if="error" class="database-state is-error" role="alert">{{ error }}</div>
      <div v-else-if="!database" class="database-empty">
        <span><Icon name="database" :size="36" /></span>
        <h2>把资料整理成可查询的数据库</h2>
        <p>建立属性、表格或看板视图，并用关系连接不同数据库。</p>
        <button type="button" class="database-primary" @click="showDatabaseModal = true"><Icon name="plus" :size="17" />创建数据库</button>
      </div>
      <template v-else>
        <header class="database-heading">
          <div>
            <span class="database-heading__eyebrow">结构化资料</span>
            <h2>{{ database.name }}</h2>
            <p v-if="database.description">{{ database.description }}</p>
          </div>
          <div class="database-heading__actions">
            <button type="button" @click="showPropertyModal = true"><Icon name="plus" :size="16" />属性</button>
            <button type="button" @click="showViewModal = true"><Icon name="plus" :size="16" />视图</button>
            <button type="button" @click="openRow()"><Icon name="plus" :size="16" />记录</button>
          </div>
        </header>

        <div class="database-viewbar">
          <div class="database-viewbar__tabs" role="tablist" aria-label="数据库视图">
            <button
              v-for="view in views"
              :key="view.id"
              type="button"
              role="tab"
              :aria-selected="view.id === activeViewId"
              :class="{ 'is-active': view.id === activeViewId }"
              @click="chooseView(view.id)"
            >
              <Icon :name="view.type === 'board' ? 'briefcase' : 'list'" :size="15" />{{ view.name }}
            </button>
          </div>
          <div class="database-viewbar__actions">
            <button type="button" @click="openViewSettings"><Icon name="settings" :size="16" />筛选与排序</button>
            <button type="button" :class="{ 'is-active': showArchived }" @click="toggleArchived"><Icon name="archive" :size="16" />归档</button>
          </div>
        </div>

        <div v-if="activeView?.type === 'board'" class="database-board" aria-label="看板视图">
          <section v-for="group in boardGroups" :key="group.id" class="database-board__column">
            <header><span :data-color="group.color || 'gray'" />{{ group.name }}<small>{{ group.rows.length }}</small></header>
            <button v-for="row in group.rows" :key="row.id" type="button" class="database-card" @click="openRow(row)">
              <strong>{{ row.title }}</strong>
              <span v-for="property in visibleProperties.filter((item) => !['title', boardProperty?.type].includes(item.type)).slice(0, 3)" :key="property.id">
                {{ property.name }}：{{ displayValue(row, property) }}
              </span>
              <small v-if="backlinksByRow[row.id]?.length">{{ backlinksByRow[row.id].length }} 条反向关联</small>
            </button>
            <button type="button" class="database-board__add" @click="openRow()"><Icon name="plus" :size="15" />新建</button>
          </section>
        </div>

        <div v-else class="database-table-wrap">
          <table class="database-table">
            <thead>
              <tr>
                <th v-for="property in visibleProperties" :key="property.id">{{ property.name }}</th>
                <th>关联</th>
                <th><span class="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.id" :class="{ 'is-archived': row.archived }">
                <td v-for="property in visibleProperties" :key="property.id">
                  <button v-if="property.type === 'title'" type="button" class="database-title-cell" @click="openRow(row)">{{ row.title }}</button>
                  <a v-else-if="property.type === 'url' && row.values?.[property.id]" :href="row.values[property.id]" target="_blank" rel="noopener noreferrer">{{ displayValue(row, property) }}</a>
                  <span v-else>{{ displayValue(row, property) }}</span>
                </td>
                <td>{{ backlinksByRow[row.id]?.length || 0 }}</td>
                <td class="database-row-actions">
                  <button type="button" aria-label="编辑记录" title="编辑" @click="openRow(row)"><Icon name="edit" :size="15" /></button>
                  <button v-if="row.archived" type="button" aria-label="恢复记录" title="恢复" @click="restoreRow(row)"><Icon name="undo" :size="15" /></button>
                  <button v-else type="button" aria-label="归档记录" title="归档" @click="archiveRow(row)"><Icon name="archive" :size="15" /></button>
                </td>
              </tr>
              <tr v-if="!rows.length"><td :colspan="visibleProperties.length + 2" class="database-table__empty">当前视图没有记录</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>

  <Modal :show="showDatabaseModal" title="新建数据库" width="560px" initial-focus-selector="#database-name" @close="showDatabaseModal = false">
    <form class="database-form" @submit.prevent="saveDatabase">
      <label for="database-name">名称</label>
      <input id="database-name" v-model="databaseDraft.name" required maxlength="120">
      <label for="database-description">说明</label>
      <textarea id="database-description" v-model="databaseDraft.description" rows="3" maxlength="8000" />
      <fieldset><legend>模板</legend>
        <label class="database-choice"><input v-model="databaseDraft.template" type="radio" value="project">项目跟踪：状态、日期和说明</label>
        <label class="database-choice"><input v-model="databaseDraft.template" type="radio" value="blank">空白数据库：仅标题属性</label>
      </fieldset>
    </form>
    <template #footer><button type="button" @click="showDatabaseModal = false">取消</button><button type="button" class="database-primary" :disabled="busy || !databaseDraft.name.trim()" @click="saveDatabase">创建</button></template>
  </Modal>

  <Modal :show="showPropertyModal" title="管理属性" width="640px" @close="showPropertyModal = false">
    <div class="database-property-list">
      <div v-for="property in properties" :key="property.id"><span><strong>{{ property.name }}</strong><small>{{ property.type }}</small></span><button v-if="property.type !== 'title'" type="button" aria-label="删除属性" @click="removeProperty(property)"><Icon name="trash" :size="16" /></button></div>
    </div>
    <form class="database-form" @submit.prevent="saveProperty">
      <label for="property-name">新属性名称</label><input id="property-name" v-model="propertyDraft.name" required maxlength="80">
      <label for="property-type">类型</label>
      <select id="property-type" v-model="propertyDraft.type">
        <option value="text">文本</option><option value="number">数字</option><option value="select">单选</option><option value="multi_select">多选</option><option value="status">状态</option><option value="date">日期</option><option value="checkbox">复选框</option><option value="url">网址</option><option value="relation">关联</option>
      </select>
      <template v-if="['select', 'multi_select', 'status'].includes(propertyDraft.type)"><label for="property-options">选项（逗号或换行分隔）</label><textarea id="property-options" v-model="propertyDraft.options" rows="3" /></template>
      <template v-if="propertyDraft.type === 'relation'"><label for="property-target">目标数据库</label><select id="property-target" v-model="propertyDraft.targetDatabaseId" required><option value="">请选择</option><option v-for="item in databases.filter((item) => item.id !== activeDatabaseId)" :key="item.id" :value="item.id">{{ item.name }}</option></select></template>
    </form>
    <template #footer><button type="button" @click="showPropertyModal = false">关闭</button><button type="button" class="database-primary" :disabled="busy || !propertyDraft.name.trim()" @click="saveProperty">添加属性</button></template>
  </Modal>

  <Modal :show="showViewModal" title="新建视图" width="520px" @close="showViewModal = false">
    <form class="database-form" @submit.prevent="saveView"><label for="view-name">名称</label><input id="view-name" v-model="viewDraft.name" required maxlength="80"><label for="view-type">类型</label><select id="view-type" v-model="viewDraft.type"><option value="table">表格</option><option value="board">看板</option></select><template v-if="viewDraft.type === 'board'"><label for="view-group">分组属性</label><select id="view-group" v-model="viewDraft.groupByPropertyId" required><option value="">请选择</option><option v-for="property in properties.filter((item) => ['status', 'select'].includes(item.type))" :key="property.id" :value="property.id">{{ property.name }}</option></select></template></form>
    <template #footer><button type="button" @click="showViewModal = false">取消</button><button type="button" class="database-primary" :disabled="busy || !viewDraft.name.trim()" @click="saveView">创建视图</button></template>
  </Modal>

  <Modal :show="showViewSettings" title="视图筛选与排序" width="760px" @close="showViewSettings = false">
    <div class="database-config-section">
      <header><strong>筛选条件</strong><button type="button" @click="addFilter"><Icon name="plus" :size="15" />添加</button></header>
      <div v-for="(filter, index) in viewConfigDraft.filters" :key="index" class="database-config-row">
        <select v-model="filter.propertyId" aria-label="筛选属性" @change="resetFilter(filter)"><option v-for="property in properties" :key="property.id" :value="property.id">{{ property.name }}</option></select>
        <select v-model="filter.operator" aria-label="筛选条件"><option v-for="([value, label]) in filterOperators(filter)" :key="value" :value="value">{{ label }}</option></select>
        <template v-if="!['is_empty', 'is_not_empty'].includes(filter.operator)">
          <select v-if="['select', 'multi_select', 'status'].includes(filterProperty(filter)?.type)" v-model="filter.value" aria-label="筛选值"><option value="">请选择</option><option v-for="option in filterProperty(filter)?.config?.options || []" :key="option.id" :value="option.id">{{ option.name }}</option></select>
          <select v-else-if="filterProperty(filter)?.type === 'checkbox'" v-model="filter.value" aria-label="筛选值"><option :value="true">已勾选</option><option :value="false">未勾选</option></select>
          <select v-else-if="filterProperty(filter)?.type === 'relation'" v-model="filter.value" aria-label="筛选值"><option value="">请选择</option><option v-for="row in relationChoices[filterProperty(filter)?.config?.targetDatabaseId] || []" :key="row.id" :value="row.id">{{ row.title }}</option></select>
          <input v-else v-model="filter.value" :type="filterProperty(filter)?.type === 'number' ? 'number' : filterProperty(filter)?.type === 'date' ? 'datetime-local' : 'text'" aria-label="筛选值">
        </template>
        <span v-else class="database-config-row__empty">无需填写</span>
        <button type="button" aria-label="删除筛选" @click="viewConfigDraft.filters.splice(index, 1)"><Icon name="trash" :size="15" /></button>
      </div>
    </div>
    <div class="database-config-section"><header><strong>排序条件</strong><button type="button" @click="addSort"><Icon name="plus" :size="15" />添加</button></header><div v-for="(sort, index) in viewConfigDraft.sorts" :key="index" class="database-config-row"><select v-model="sort.propertyId"><option v-for="property in properties" :key="property.id" :value="property.id">{{ property.name }}</option></select><select v-model="sort.direction"><option value="asc">升序</option><option value="desc">降序</option></select><button type="button" aria-label="删除排序" @click="viewConfigDraft.sorts.splice(index, 1)"><Icon name="trash" :size="15" /></button></div></div>
    <div class="database-config-section">
      <header><strong>可见属性</strong><span class="database-config-section__hint">至少保留一个属性</span></header>
      <div class="database-visible-properties">
        <label v-for="property in properties" :key="property.id" class="database-choice"><input v-model="viewConfigDraft.visiblePropertyIds" type="checkbox" :value="property.id" :disabled="viewConfigDraft.visiblePropertyIds.length === 1 && viewConfigDraft.visiblePropertyIds.includes(property.id)">{{ property.name }}</label>
      </div>
    </div>
    <div v-if="activeView?.type === 'board'" class="database-form"><label for="settings-group">看板分组</label><select id="settings-group" v-model="viewConfigDraft.groupByPropertyId"><option value="">自动选择</option><option v-for="property in properties.filter((item) => ['status', 'select'].includes(item.type))" :key="property.id" :value="property.id">{{ property.name }}</option></select></div>
    <template #footer><button type="button" @click="showViewSettings = false">取消</button><button type="button" class="database-primary" :disabled="busy" @click="saveViewSettings">保存视图</button></template>
  </Modal>

  <Modal :show="showRowModal" :title="editingRow ? '编辑记录' : '新建记录'" width="720px" initial-focus-selector="#database-row-title" @close="showRowModal = false">
    <form class="database-form database-form--row" @submit.prevent="saveRow"><label for="database-row-title">标题</label><input id="database-row-title" v-model="rowDraft.title" required maxlength="500"><template v-for="property in properties.filter((item) => item.type !== 'title')" :key="property.id"><label :for="`row-property-${property.id}`">{{ property.name }}</label><input v-if="['text', 'number', 'url', 'date'].includes(property.type)" :id="`row-property-${property.id}`" v-model="rowDraft.values[property.id]" :type="property.type === 'number' ? 'number' : property.type === 'date' ? 'datetime-local' : property.type === 'url' ? 'url' : 'text'"><label v-else-if="property.type === 'checkbox'" class="database-choice"><input :id="`row-property-${property.id}`" v-model="rowDraft.values[property.id]" type="checkbox">已勾选</label><select v-else-if="['select', 'status'].includes(property.type)" :id="`row-property-${property.id}`" v-model="rowDraft.values[property.id]"><option value="">未设置</option><option v-for="option in property.config.options" :key="option.id" :value="option.id">{{ option.name }}</option></select><select v-else-if="property.type === 'multi_select'" :id="`row-property-${property.id}`" v-model="rowDraft.values[property.id]" multiple><option v-for="option in property.config.options" :key="option.id" :value="option.id">{{ option.name }}</option></select><select v-else-if="property.type === 'relation'" :id="`row-property-${property.id}`" v-model="rowDraft.values[property.id]" multiple><option v-for="target in relationChoices[property.config.targetDatabaseId] || []" :key="target.id" :value="target.id">{{ target.title }}</option></select></template><section v-if="editingRow && backlinksByRow[editingRow.id]?.length" class="database-backlinks"><h3>反向关联</h3><div v-for="link in backlinksByRow[editingRow.id]" :key="`${link.sourcePropertyId}:${link.sourceRowId}`"><Icon name="link" :size="15" /><span><strong>{{ link.sourceRowTitle }}</strong><small>{{ link.sourceDatabaseName }} · {{ link.sourcePropertyName }}</small></span></div></section></form>
    <template #footer><button type="button" @click="showRowModal = false">取消</button><button type="button" class="database-primary" :disabled="busy || !rowDraft.title.trim()" @click="saveRow">保存记录</button></template>
  </Modal>
</template>

<style scoped>
.database-workspace { display: grid; min-height: 620px; grid-template-columns: minmax(210px, 260px) minmax(0, 1fr); overflow: hidden; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.database-sidebar { padding: 14px; background: color-mix(in srgb, var(--bg-secondary) 78%, var(--bg-card)); border-right: 1px solid var(--border-light); }
.database-sidebar__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 6px; }
.database-sidebar__header > div, .database-sidebar__item > span { display: grid; gap: 3px; min-width: 0; }
.database-sidebar small, .database-heading p, .database-card span, .database-card small { color: var(--text-muted); }
.database-sidebar button, .database-viewbar button, .database-heading button, .database-row-actions button, .database-config-section button, .database-property-list button { min-width: 44px; min-height: 44px; color: var(--text-secondary); background: transparent; border: 0; border-radius: 12px; cursor: pointer; }
.database-sidebar__item { display: grid; width: 100%; margin: 4px 0; padding: 9px 10px; align-items: center; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; text-align: left; }
.database-sidebar__item.is-active { color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 12%, transparent); }
.database-sidebar__item strong, .database-sidebar__item small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.database-sidebar__empty { padding: 20px 8px; color: var(--text-muted); font-size: .86rem; text-align: center; }
.database-main { min-width: 0; padding: clamp(16px, 2.5vw, 30px); }
.database-state, .database-empty { display: grid; min-height: 480px; place-content: center; justify-items: center; gap: 12px; color: var(--text-muted); text-align: center; }
.database-state.is-error { color: var(--danger-color, #b42318); }
.database-empty span { display: grid; width: 72px; height: 72px; place-items: center; color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 10%, transparent); border-radius: 22px; }
.database-empty h2 { margin: 4px 0 0; color: var(--text-primary); }
.database-empty p { max-width: 440px; margin: 0 0 8px; }
.database-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.database-heading h2 { margin: 4px 0; color: var(--text-primary); font-size: clamp(1.45rem, 3vw, 2rem); }
.database-heading__eyebrow { color: var(--accent-color); font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.database-heading__actions, .database-viewbar__actions { display: flex; flex-wrap: wrap; gap: 6px; }
.database-heading__actions button, .database-viewbar__actions button { display: inline-flex; min-width: auto; padding: 0 12px; align-items: center; gap: 6px; border: 1px solid var(--border-light); }
.database-viewbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 22px 0 14px; border-bottom: 1px solid var(--border-light); }
.database-viewbar__tabs { display: flex; overflow-x: auto; }
.database-viewbar__tabs button { display: inline-flex; min-width: auto; padding: 0 12px; align-items: center; gap: 6px; white-space: nowrap; border-radius: 10px 10px 0 0; }
.database-viewbar__tabs button.is-active { color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 9%, transparent); box-shadow: inset 0 -2px var(--accent-color); }
.database-viewbar__actions .is-active { color: var(--accent-color); }
.database-table-wrap { overflow: auto; border: 1px solid var(--border-light); border-radius: 14px; }
.database-table { width: 100%; min-width: 760px; border-collapse: collapse; }
.database-table th, .database-table td { max-width: 320px; padding: 12px 14px; overflow: hidden; border-bottom: 1px solid var(--border-light); text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.database-table th { position: sticky; z-index: 1; top: 0; color: var(--text-muted); background: var(--bg-secondary); font-size: .72rem; letter-spacing: .04em; }
.database-table tr:last-child td { border-bottom: 0; }
.database-table tr.is-archived { opacity: .6; }
.database-title-cell { color: var(--text-primary); font-weight: 650; background: transparent; border: 0; cursor: pointer; }
.database-row-actions { display: flex; justify-content: flex-end; }
.database-row-actions button { min-width: 38px; min-height: 38px; }
.database-table__empty { padding: 42px !important; color: var(--text-muted); text-align: center !important; }
.database-board { display: grid; grid-auto-columns: minmax(250px, 320px); grid-auto-flow: column; gap: 14px; overflow-x: auto; padding-bottom: 10px; }
.database-board__column { min-height: 420px; padding: 12px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 16px; }
.database-board__column > header { display: flex; align-items: center; gap: 8px; padding: 5px 4px 12px; color: var(--text-primary); font-weight: 700; }
.database-board__column > header span { width: 9px; height: 9px; background: var(--text-muted); border-radius: 99px; }
.database-board__column > header span[data-color="blue"] { background: #4f72db; }.database-board__column > header span[data-color="green"] { background: #4f8a5b; }.database-board__column > header span[data-color="red"] { background: #c45757; }.database-board__column > header span[data-color="yellow"] { background: #b58a28; }.database-board__column > header span[data-color="purple"] { background: #7759c2; }
.database-board__column > header small { margin-left: auto; color: var(--text-muted); }
.database-card { display: grid; width: 100%; margin-bottom: 9px; padding: 13px; gap: 6px; color: var(--text-primary); text-align: left; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; box-shadow: var(--shadow-sm); cursor: pointer; }
.database-card span, .database-card small { overflow: hidden; font-size: .74rem; text-overflow: ellipsis; white-space: nowrap; }
.database-board__add { display: inline-flex; min-height: 44px; align-items: center; gap: 6px; color: var(--text-muted); background: transparent; border: 0; cursor: pointer; }
.database-primary { display: inline-flex; min-height: 44px; padding: 0 18px; align-items: center; justify-content: center; gap: 7px; color: var(--accent-text, #fff) !important; background: var(--accent-color) !important; border: 0; border-radius: 13px; cursor: pointer; }
.database-primary:disabled { opacity: .48; cursor: not-allowed; }
.database-form { display: grid; gap: 10px; }
.database-form label, .database-form legend { color: var(--text-secondary); font-size: .82rem; font-weight: 650; }
.database-form input:not([type="radio"]):not([type="checkbox"]), .database-form textarea, .database-form select, .database-config-row input, .database-config-row select { width: 100%; min-height: 44px; padding: 10px 12px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.database-form fieldset { display: grid; gap: 8px; margin: 4px 0 0; padding: 12px; border: 1px solid var(--border-light); border-radius: 12px; }
.database-choice { display: flex; min-height: 44px; align-items: center; gap: 9px; font-weight: 500 !important; }
.database-form--row { grid-template-columns: minmax(130px, .35fr) minmax(0, 1fr); align-items: center; }
.database-form--row > label:not(.database-choice), .database-form--row > .database-backlinks { grid-column: 1; }
.database-form--row > input, .database-form--row > select, .database-form--row > .database-choice { grid-column: 2; }
.database-property-list { display: grid; gap: 6px; margin-bottom: 18px; }
.database-property-list > div { display: flex; min-height: 52px; padding: 7px 8px 7px 12px; align-items: center; justify-content: space-between; background: var(--bg-secondary); border-radius: 12px; }
.database-property-list span { display: grid; gap: 2px; }.database-property-list small { color: var(--text-muted); }
.database-config-section { margin-bottom: 18px; }.database-config-section > header { display: flex; min-height: 44px; align-items: center; justify-content: space-between; }.database-config-section header button { display: inline-flex; align-items: center; gap: 5px; }
.database-config-row { display: grid; margin-bottom: 7px; grid-template-columns: minmax(140px, 1fr) minmax(120px, .7fr) minmax(120px, 1fr) 44px; gap: 7px; }
.database-config-row__empty, .database-config-section__hint { display: inline-flex; min-height: 44px; align-items: center; color: var(--text-muted); font-size: .86rem; }
.database-visible-properties { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px 12px; }
.database-visible-properties .database-choice { padding: 0 10px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.database-backlinks { grid-column: 1 / -1 !important; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-light); }.database-backlinks h3 { margin: 0 0 8px; font-size: .9rem; }.database-backlinks > div { display: flex; padding: 8px; align-items: center; gap: 8px; }.database-backlinks span { display: grid; }.database-backlinks small { color: var(--text-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 820px) { .database-workspace { grid-template-columns: 1fr; }.database-sidebar { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border-light); }.database-sidebar__header { min-width: 145px; margin: 0 8px 0 0; }.database-sidebar__item { width: auto; min-width: 150px; }.database-heading { display: grid; }.database-viewbar { align-items: flex-start; flex-direction: column; }.database-viewbar__actions { padding-bottom: 8px; }.database-form--row { grid-template-columns: 1fr; }.database-form--row > * { grid-column: 1 !important; }.database-config-row { grid-template-columns: 1fr 1fr; }.database-config-row > button { justify-self: end; }.database-visible-properties { grid-template-columns: 1fr 1fr; } }
</style>
