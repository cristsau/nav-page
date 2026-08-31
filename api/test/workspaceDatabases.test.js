import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  WorkspaceDatabaseError,
  applyWorkspaceDatabaseView,
  normalizeWorkspaceDatabaseProperties,
  normalizeWorkspaceDatabaseRowValues,
  normalizeWorkspaceDatabaseViewConfig
} from '../src/lib/workspaceDatabases.js'

const uuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

test('database properties add one immutable title and normalize typed options', () => {
  const properties = normalizeWorkspaceDatabaseProperties([
    {
      id: uuid(2),
      name: '状态',
      type: 'status',
      config: {
        options: [
          { id: uuid(20), name: '待处理', color: 'gray' },
          { id: uuid(21), name: '完成', color: 'green' }
        ]
      }
    }
  ])
  assert.equal(properties.length, 2)
  assert.equal(properties[0].type, 'title')
  assert.equal(properties[1].config.options[1].name, '完成')
})

test('database properties reject duplicate title and duplicate option names', () => {
  assert.throws(() => normalizeWorkspaceDatabaseProperties([
    { id: uuid(1), name: '标题', type: 'title', config: {} },
    { id: uuid(2), name: '第二标题', type: 'title', config: {} }
  ]), (error) => error instanceof WorkspaceDatabaseError
    && error.code === 'workspace_database_title_property_duplicate')

  assert.throws(() => normalizeWorkspaceDatabaseProperties([
    {
      id: uuid(3),
      name: '优先级',
      type: 'select',
      config: {
        options: [
          { id: uuid(31), name: '高', color: 'red' },
          { id: uuid(32), name: '高', color: 'blue' }
        ]
      }
    }
  ]), (error) => error instanceof WorkspaceDatabaseError
    && error.code === 'workspace_database_option_duplicate')
})

test('row values are type checked and relations retain owned UUID identities', () => {
  const properties = normalizeWorkspaceDatabaseProperties([
    { id: uuid(1), name: '名称', type: 'title', config: {} },
    { id: uuid(2), name: '金额', type: 'number', config: { format: 'currency' } },
    { id: uuid(3), name: '完成', type: 'checkbox', config: {} },
    {
      id: uuid(4),
      name: '关联项目',
      type: 'relation',
      config: { targetDatabaseId: uuid(90), allowMultiple: true }
    }
  ])
  assert.deepEqual(normalizeWorkspaceDatabaseRowValues({
    [uuid(2)]: '12.5',
    [uuid(3)]: true,
    [uuid(4)]: [uuid(100), uuid(101), uuid(100)]
  }, properties), {
    [uuid(2)]: 12.5,
    [uuid(3)]: true,
    [uuid(4)]: [uuid(100), uuid(101)]
  })
  assert.throws(() => normalizeWorkspaceDatabaseRowValues({
    [uuid(999)]: 'unexpected'
  }, properties), (error) => error.code === 'workspace_database_property_not_found')
})

test('table and board view config validates properties and applies filters and stable sorts', () => {
  const properties = normalizeWorkspaceDatabaseProperties([
    { id: uuid(1), name: '名称', type: 'title', config: {} },
    { id: uuid(2), name: '分数', type: 'number', config: {} },
    {
      id: uuid(3),
      name: '状态',
      type: 'status',
      config: {
        options: [
          { id: uuid(31), name: '进行中', color: 'blue' },
          { id: uuid(32), name: '完成', color: 'green' }
        ]
      }
    }
  ])
  const config = normalizeWorkspaceDatabaseViewConfig({
    filters: [{ propertyId: uuid(3), operator: 'equals', value: uuid(31) }],
    sorts: [{ propertyId: uuid(2), direction: 'desc' }],
    visiblePropertyIds: [uuid(1), uuid(2), uuid(3)],
    groupByPropertyId: uuid(3)
  }, properties)
  const rows = [
    { id: uuid(101), title: 'A', values: { [uuid(2)]: 3, [uuid(3)]: uuid(31) }, position: 1 },
    { id: uuid(102), title: 'B', values: { [uuid(2)]: 9, [uuid(3)]: uuid(31) }, position: 2 },
    { id: uuid(103), title: 'C', values: { [uuid(2)]: 100, [uuid(3)]: uuid(32) }, position: 3 }
  ]
  assert.deepEqual(
    applyWorkspaceDatabaseView(rows, properties, config).map((row) => row.title),
    ['B', 'A']
  )

  const numericConfig = normalizeWorkspaceDatabaseViewConfig({
    filters: [{ propertyId: uuid(2), operator: 'gte', value: '9' }],
    visiblePropertyIds: [uuid(1), uuid(2)]
  }, properties)
  assert.equal(numericConfig.filters[0].value, 9)
  assert.deepEqual(
    applyWorkspaceDatabaseView(rows, properties, numericConfig).map((row) => row.title),
    ['B', 'C']
  )
  assert.throws(() => normalizeWorkspaceDatabaseViewConfig({
    filters: [{ propertyId: uuid(3), operator: 'gt', value: uuid(31) }],
    visiblePropertyIds: [uuid(1)]
  }, properties), (error) => error.code === 'workspace_database_filter_operator_invalid')
  assert.throws(() => normalizeWorkspaceDatabaseViewConfig({
    visiblePropertyIds: []
  }, properties), (error) => error.code === 'workspace_database_visible_properties_invalid')
})

test('migration and route preserve user ownership, relations, backlinks and archive recovery', async () => {
  const [migration, route] = await Promise.all([
    readFile(new URL('../src/db/migrations/045_workspace_databases.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/workspaceDatabases.js', import.meta.url), 'utf8')
  ])
  for (const fragment of [
    'workspace_databases',
    'workspace_database_properties',
    'workspace_database_views',
    'workspace_database_rows',
    'workspace_database_relations',
    'idx_workspace_database_properties_one_title',
    'idx_workspace_database_rows_values_gin'
  ]) assert.match(migration, new RegExp(fragment))
  assert.match(migration, /FOREIGN KEY \(database_id, user_id\)/)
  assert.match(migration, /CHECK \(source_row_id <> target_row_id\)/)
  assert.match(route, /relation\.user_id = \$1/)
  assert.match(route, /assertPropertyConfigCompatible/)
  assert.match(route, /workspace_database_property_option_in_use/)
  assert.match(route, /repairViewsAfterPropertyDeletion/)
  assert.match(route, /filter\.propertyId !== deletedPropertyId/)
  assert.match(route, /SET archived = TRUE/)
  assert.match(route, /SET archived = FALSE/)
  assert.match(route, /LIMIT 5000/)
})
