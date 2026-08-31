import { randomUUID } from 'node:crypto'
import { isUuid } from './offlineMutations.js'
import { normalizeHttpUrl } from './urls.js'

export const WORKSPACE_DATABASE_PROPERTY_TYPES = Object.freeze([
  'title',
  'text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'relation'
])

export const WORKSPACE_DATABASE_VIEW_TYPES = Object.freeze(['table', 'board'])

const PROPERTY_TYPE_SET = new Set(WORKSPACE_DATABASE_PROPERTY_TYPES)
const VIEW_TYPE_SET = new Set(WORKSPACE_DATABASE_VIEW_TYPES)
const FILTER_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
  'before',
  'after'
])
const FILTER_OPERATORS_BY_TYPE = Object.freeze({
  title: new Set(['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty']),
  text: new Set(['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty']),
  number: new Set(['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty']),
  select: new Set(['equals', 'not_equals', 'is_empty', 'is_not_empty']),
  multi_select: new Set(['contains', 'not_contains', 'is_empty', 'is_not_empty']),
  status: new Set(['equals', 'not_equals', 'is_empty', 'is_not_empty']),
  date: new Set(['equals', 'not_equals', 'before', 'after', 'is_empty', 'is_not_empty']),
  checkbox: new Set(['equals', 'not_equals']),
  url: new Set(['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty']),
  relation: new Set(['contains', 'not_contains', 'is_empty', 'is_not_empty'])
})
const OPTION_COLORS = new Set([
  'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'
])
const MAX_PROPERTIES = 80
const MAX_OPTIONS = 100
const MAX_FILTERS = 20
const MAX_SORTS = 8
const MAX_RELATIONS = 100

export class WorkspaceDatabaseError extends Error {
  constructor(message, {
    code = 'workspace_database_invalid',
    statusCode = 400,
    details = null
  } = {}) {
    super(message)
    this.name = 'WorkspaceDatabaseError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function fail(message, code = 'workspace_database_invalid', statusCode = 400, details = null) {
  throw new WorkspaceDatabaseError(message, { code, statusCode, details })
}

function exactObject(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}必须是对象`, 'workspace_database_object_invalid')
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unknown.length) {
    fail(`${label}包含不支持的字段`, 'workspace_database_unknown_fields', 400, {
      fields: unknown.slice(0, 20)
    })
  }
}

function text(value, label, {
  required = false,
  max = 1000,
  fallback = ''
} = {}) {
  const normalized = String(value ?? fallback).trim()
  if (required && !normalized) fail(`${label}不能为空`, 'workspace_database_value_required')
  if ([...normalized].length > max) {
    fail(`${label}不能超过 ${max} 个字符`, 'workspace_database_value_too_long')
  }
  return normalized
}

function uuid(value, label, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null
  const normalized = String(value || '').trim().toLowerCase()
  if (!isUuid(normalized)) fail(`${label}格式无效`, 'workspace_database_uuid_invalid')
  return normalized
}

function normalizeOption(option, seenNames, seenIds) {
  exactObject(option, ['id', 'name', 'color'], '选项')
  const name = text(option.name, '选项名称', { required: true, max: 80 })
  const normalizedName = name.toLocaleLowerCase('zh-CN')
  if (seenNames.has(normalizedName)) {
    fail('同一属性不能包含重名选项', 'workspace_database_option_duplicate')
  }
  seenNames.add(normalizedName)
  const id = option.id ? uuid(option.id, '选项 ID') : randomUUID()
  if (seenIds.has(id)) fail('选项 ID 重复', 'workspace_database_option_duplicate')
  seenIds.add(id)
  const color = String(option.color || 'gray').trim().toLowerCase()
  if (!OPTION_COLORS.has(color)) {
    fail('选项颜色无效', 'workspace_database_option_color_invalid')
  }
  return { id, name, color }
}

export function normalizeWorkspaceDatabasePropertyConfig(type, value = {}) {
  if (!PROPERTY_TYPE_SET.has(type)) {
    fail('属性类型无效', 'workspace_database_property_type_invalid')
  }
  const source = value ?? {}
  if (type === 'select' || type === 'multi_select' || type === 'status') {
    exactObject(source, ['options'], '属性配置')
    const options = source.options ?? []
    if (!Array.isArray(options) || options.length > MAX_OPTIONS) {
      fail(`属性选项不能超过 ${MAX_OPTIONS} 个`, 'workspace_database_options_invalid')
    }
    const seenNames = new Set()
    const seenIds = new Set()
    return { options: options.map((option) => normalizeOption(option, seenNames, seenIds)) }
  }
  if (type === 'number') {
    exactObject(source, ['format'], '属性配置')
    const format = String(source.format || 'number').trim().toLowerCase()
    if (!['number', 'currency', 'percent'].includes(format)) {
      fail('数字格式无效', 'workspace_database_number_format_invalid')
    }
    return { format }
  }
  if (type === 'date') {
    exactObject(source, ['includeTime'], '属性配置')
    return { includeTime: Boolean(source.includeTime) }
  }
  if (type === 'relation') {
    exactObject(source, ['targetDatabaseId', 'allowMultiple'], '属性配置')
    return {
      targetDatabaseId: uuid(source.targetDatabaseId, '关联数据库 ID'),
      allowMultiple: source.allowMultiple !== false
    }
  }
  exactObject(source, [], '属性配置')
  return {}
}

export function normalizeWorkspaceDatabaseProperties(value, {
  ensureTitle = true
} = {}) {
  const source = value ?? []
  if (!Array.isArray(source) || source.length > MAX_PROPERTIES) {
    fail(`属性数量不能超过 ${MAX_PROPERTIES} 个`, 'workspace_database_properties_invalid')
  }
  const properties = source.map((property, index) => {
    exactObject(property, ['id', 'name', 'type', 'config', 'displayOrder'], '属性')
    const type = String(property.type || 'text').trim().toLowerCase()
    if (!PROPERTY_TYPE_SET.has(type)) {
      fail('属性类型无效', 'workspace_database_property_type_invalid')
    }
    return {
      id: property.id ? uuid(property.id, '属性 ID') : randomUUID(),
      name: text(property.name, '属性名称', { required: true, max: 80 }),
      type,
      config: normalizeWorkspaceDatabasePropertyConfig(type, property.config),
      displayOrder: Number.isSafeInteger(Number(property.displayOrder))
        ? Math.max(0, Math.min(10000, Number(property.displayOrder)))
        : index
    }
  })
  const names = new Set()
  const ids = new Set()
  let titleCount = 0
  for (const property of properties) {
    const name = property.name.toLocaleLowerCase('zh-CN')
    if (names.has(name)) fail('属性名称不能重复', 'workspace_database_property_duplicate')
    if (ids.has(property.id)) fail('属性 ID 不能重复', 'workspace_database_property_duplicate')
    names.add(name)
    ids.add(property.id)
    if (property.type === 'title') titleCount += 1
  }
  if (titleCount > 1) fail('一个数据库只能有一个标题属性', 'workspace_database_title_property_duplicate')
  if (ensureTitle && titleCount === 0) {
    properties.unshift({
      id: randomUUID(),
      name: '名称',
      type: 'title',
      config: {},
      displayOrder: 0
    })
    for (let index = 1; index < properties.length; index += 1) {
      properties[index].displayOrder = Math.max(properties[index].displayOrder, index)
    }
  }
  return properties.sort((left, right) => left.displayOrder - right.displayOrder)
}

function normalizeFilterValue(property, value) {
  if (property.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) fail('数字筛选值无效', 'workspace_database_filter_value_invalid')
    return number
  }
  if (property.type === 'checkbox') {
    if (value === true || value === false) return value
    if (String(value).toLowerCase() === 'true') return true
    if (String(value).toLowerCase() === 'false') return false
    fail('复选框筛选值无效', 'workspace_database_filter_value_invalid')
  }
  if (property.type === 'date') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) fail('日期筛选值无效', 'workspace_database_filter_value_invalid')
    return date.toISOString()
  }
  if (['select', 'multi_select', 'status', 'relation'].includes(property.type)) {
    return uuid(value, '筛选值 ID')
  }
  return text(value, '筛选值', { max: 1000 })
}

function normalizeFilter(filter, propertyMap) {
  exactObject(filter, ['propertyId', 'operator', 'value'], '筛选条件')
  const propertyId = uuid(filter.propertyId, '筛选属性 ID')
  const property = propertyMap.get(propertyId)
  if (!property) {
    fail('筛选属性不存在', 'workspace_database_view_property_not_found')
  }
  const operator = String(filter.operator || 'equals').trim().toLowerCase()
  if (!FILTER_OPERATORS.has(operator)) {
    fail('筛选运算符无效', 'workspace_database_filter_operator_invalid')
  }
  if (!FILTER_OPERATORS_BY_TYPE[property.type]?.has(operator)) {
    fail('该属性不支持这个筛选条件', 'workspace_database_filter_operator_invalid')
  }
  return {
    propertyId,
    operator,
    value: ['is_empty', 'is_not_empty'].includes(operator)
      ? null
      : normalizeFilterValue(property, filter.value)
  }
}

export function normalizeWorkspaceDatabaseViewConfig(value = {}, properties = []) {
  const source = value ?? {}
  exactObject(source, ['filters', 'sorts', 'visiblePropertyIds', 'groupByPropertyId'], '视图配置')
  const propertyMap = new Map(properties.map((property) => [property.id, property]))
  const propertyIds = new Set(propertyMap.keys())
  const filters = source.filters ?? []
  const sorts = source.sorts ?? []
  const visiblePropertyIds = source.visiblePropertyIds ?? properties.map((property) => property.id)
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) {
    fail(`筛选条件不能超过 ${MAX_FILTERS} 个`, 'workspace_database_filters_invalid')
  }
  if (!Array.isArray(sorts) || sorts.length > MAX_SORTS) {
    fail(`排序条件不能超过 ${MAX_SORTS} 个`, 'workspace_database_sorts_invalid')
  }
  if (!Array.isArray(visiblePropertyIds) || visiblePropertyIds.length === 0 || visiblePropertyIds.length > MAX_PROPERTIES) {
    fail('可见属性列表无效', 'workspace_database_visible_properties_invalid')
  }
  const normalizedVisible = [...new Set(visiblePropertyIds.map((id) => uuid(id, '可见属性 ID')))]
  if (normalizedVisible.some((id) => !propertyIds.has(id))) {
    fail('可见属性不存在', 'workspace_database_view_property_not_found')
  }
  const normalizedSorts = sorts.map((sort) => {
    exactObject(sort, ['propertyId', 'direction'], '排序条件')
    const propertyId = uuid(sort.propertyId, '排序属性 ID')
    if (!propertyIds.has(propertyId)) {
      fail('排序属性不存在', 'workspace_database_view_property_not_found')
    }
    const direction = String(sort.direction || 'asc').trim().toLowerCase()
    if (!['asc', 'desc'].includes(direction)) {
      fail('排序方向无效', 'workspace_database_sort_direction_invalid')
    }
    return { propertyId, direction }
  })
  const groupByPropertyId = uuid(source.groupByPropertyId, '分组属性 ID', { nullable: true })
  if (groupByPropertyId && !propertyIds.has(groupByPropertyId)) {
    fail('分组属性不存在', 'workspace_database_view_property_not_found')
  }
  return {
    filters: filters.map((filter) => normalizeFilter(filter, propertyMap)),
    sorts: normalizedSorts,
    visiblePropertyIds: normalizedVisible,
    groupByPropertyId
  }
}

function normalizeSinglePropertyValue(property, value) {
  if (value === undefined || value === null || value === '') return null
  if (property.type === 'title') return null
  if (property.type === 'text') return text(value, property.name, { max: 10000 })
  if (property.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) fail(`${property.name}必须是数字`, 'workspace_database_property_value_invalid')
    return number
  }
  if (property.type === 'checkbox') return Boolean(value)
  if (property.type === 'url') {
    const url = normalizeHttpUrl(value)
    if (!url) fail(`${property.name}必须是 HTTP 或 HTTPS 地址`, 'workspace_database_property_value_invalid')
    return url
  }
  if (property.type === 'date') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) fail(`${property.name}日期无效`, 'workspace_database_property_value_invalid')
    return date.toISOString()
  }
  if (property.type === 'select' || property.type === 'status') {
    const optionId = uuid(value, `${property.name}选项 ID`)
    if (!property.config.options.some((option) => option.id === optionId)) {
      fail(`${property.name}选项不存在`, 'workspace_database_option_not_found')
    }
    return optionId
  }
  if (property.type === 'multi_select') {
    if (!Array.isArray(value) || value.length > MAX_OPTIONS) {
      fail(`${property.name}多选值无效`, 'workspace_database_property_value_invalid')
    }
    const ids = [...new Set(value.map((item) => uuid(item, `${property.name}选项 ID`)))]
    if (ids.some((id) => !property.config.options.some((option) => option.id === id))) {
      fail(`${property.name}选项不存在`, 'workspace_database_option_not_found')
    }
    return ids
  }
  if (property.type === 'relation') {
    const values = Array.isArray(value) ? value : [value]
    if (values.length > MAX_RELATIONS || (!property.config.allowMultiple && values.length > 1)) {
      fail(`${property.name}关联数量无效`, 'workspace_database_relations_invalid')
    }
    return [...new Set(values.map((item) => uuid(item, `${property.name}关联记录 ID`)))]
  }
  return null
}

export function normalizeWorkspaceDatabaseRowValues(value, properties) {
  const source = value ?? {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    fail('记录属性值必须是对象', 'workspace_database_row_values_invalid')
  }
  const propertyMap = new Map(properties.map((property) => [property.id, property]))
  const unknown = Object.keys(source).filter((id) => !propertyMap.has(id))
  if (unknown.length) {
    fail('记录包含不存在的属性', 'workspace_database_property_not_found', 400, {
      propertyIds: unknown.slice(0, 20)
    })
  }
  const normalized = {}
  for (const [propertyId, raw] of Object.entries(source)) {
    const property = propertyMap.get(propertyId)
    const result = normalizeSinglePropertyValue(property, raw)
    if (result !== null) normalized[propertyId] = result
  }
  return normalized
}

export async function assertWorkspaceDatabaseRelationTargets(client, userId, sourceRowId, properties, values) {
  const expected = []
  for (const property of properties) {
    if (property.type !== 'relation') continue
    const targetIds = values[property.id] || []
    for (const targetId of targetIds) {
      if (sourceRowId && targetId === sourceRowId) {
        fail('记录不能关联自身', 'workspace_database_relation_self_invalid')
      }
      expected.push({
        propertyId: property.id,
        targetId,
        targetDatabaseId: property.config.targetDatabaseId
      })
    }
  }
  if (!expected.length) return []
  const targetIds = [...new Set(expected.map((item) => item.targetId))]
  const { rows } = await client.query(
    `SELECT id,database_id FROM workspace_database_rows
     WHERE user_id=$1 AND id=ANY($2::uuid[]) AND archived=FALSE
     FOR KEY SHARE`,
    [userId, targetIds]
  )
  const targetMap = new Map(rows.map((row) => [row.id, row.database_id]))
  for (const relation of expected) {
    if (targetMap.get(relation.targetId) !== relation.targetDatabaseId) {
      fail('关联记录不存在或不属于目标数据库', 'workspace_database_relation_target_invalid')
    }
  }
  return expected
}

export async function syncWorkspaceDatabaseRelations(client, userId, sourceRowId, sourceDatabaseId, relations) {
  await client.query(
    'DELETE FROM workspace_database_relations WHERE source_row_id=$1 AND user_id=$2',
    [sourceRowId, userId]
  )
  for (const relation of relations) {
    await client.query(
      `INSERT INTO workspace_database_relations(
         source_row_id,source_database_id,source_property_id,
         target_row_id,target_database_id,user_id
       ) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [sourceRowId, sourceDatabaseId, relation.propertyId, relation.targetId, relation.targetDatabaseId, userId]
    )
  }
}

export function mapWorkspaceDatabase(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    icon: row.icon || 'database',
    rowCount: row.row_count === undefined ? undefined : Number(row.row_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function mapWorkspaceDatabaseProperty(row) {
  return {
    id: row.id,
    databaseId: row.database_id,
    name: row.name,
    type: row.type,
    config: row.config || {},
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function mapWorkspaceDatabaseView(row) {
  return {
    id: row.id,
    databaseId: row.database_id,
    name: row.name,
    type: row.type,
    config: row.config || {},
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function mapWorkspaceDatabaseRow(row) {
  return {
    id: row.id,
    databaseId: row.database_id,
    title: row.title,
    values: row.values || {},
    position: Number(row.position || 0),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function propertyValue(row, property) {
  return property.type === 'title' ? row.title : row.values?.[property.id] ?? null
}

function emptyValue(value) {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function comparable(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.join('\u0000').toLocaleLowerCase('zh-CN')
  return String(value).toLocaleLowerCase('zh-CN')
}

function matchesFilter(value, filter) {
  if (filter.operator === 'is_empty') return emptyValue(value)
  if (filter.operator === 'is_not_empty') return !emptyValue(value)
  const actual = comparable(value)
  const expected = comparable(filter.value)
  if (filter.operator === 'equals') return actual === expected
  if (filter.operator === 'not_equals') return actual !== expected
  if (filter.operator === 'contains') {
    if (Array.isArray(value)) return value.some((item) => comparable(item) === expected)
    return String(actual ?? '').includes(String(expected ?? ''))
  }
  if (filter.operator === 'not_contains') return !matchesFilter(value, { ...filter, operator: 'contains' })
  if (actual === null || expected === null) return false
  if (filter.operator === 'gt' || filter.operator === 'after') return actual > expected
  if (filter.operator === 'gte') return actual >= expected
  if (filter.operator === 'lt' || filter.operator === 'before') return actual < expected
  if (filter.operator === 'lte') return actual <= expected
  return false
}

export function applyWorkspaceDatabaseView(rows, properties, config = {}) {
  const propertyMap = new Map(properties.map((property) => [property.id, property]))
  const filters = Array.isArray(config.filters) ? config.filters : []
  const sorts = Array.isArray(config.sorts) ? config.sorts : []
  const filtered = rows.filter((row) => filters.every((filter) => {
    const property = propertyMap.get(filter.propertyId)
    return property ? matchesFilter(propertyValue(row, property), filter) : false
  }))
  return filtered.sort((left, right) => {
    for (const sort of sorts) {
      const property = propertyMap.get(sort.propertyId)
      if (!property) continue
      const leftValue = comparable(propertyValue(left, property))
      const rightValue = comparable(propertyValue(right, property))
      if (leftValue === rightValue) continue
      const direction = sort.direction === 'desc' ? -1 : 1
      if (leftValue === null) return direction
      if (rightValue === null) return -direction
      return leftValue < rightValue ? -direction : direction
    }
    if (left.position !== right.position) return left.position - right.position
    return String(left.id).localeCompare(String(right.id))
  })
}

export function normalizeWorkspaceDatabaseIdentity(value, label = '数据库 ID') {
  return uuid(value, label)
}

export function normalizeWorkspaceDatabaseName(value, label = '数据库名称') {
  return text(value, label, { required: true, max: 120 })
}

export function normalizeWorkspaceDatabaseDescription(value) {
  return text(value, '数据库说明', { max: 8000 })
}

export function normalizeWorkspaceDatabaseIcon(value) {
  const icon = text(value || 'database', '数据库图标', { required: true, max: 32 }).toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(icon)) {
    fail('数据库图标名称无效', 'workspace_database_icon_invalid')
  }
  return icon
}

export function normalizeWorkspaceDatabaseViewType(value) {
  const type = String(value || 'table').trim().toLowerCase()
  if (!VIEW_TYPE_SET.has(type)) fail('视图类型无效', 'workspace_database_view_type_invalid')
  return type
}

export function normalizeWorkspaceDatabaseRowTitle(value) {
  return text(value, '记录标题', { required: true, max: 500 })
}
