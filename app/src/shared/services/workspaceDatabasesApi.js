import { apiRequest as request } from '@/shared/services/apiClient'

function id(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label}缺失`)
  return encodeURIComponent(normalized)
}

export async function fetchWorkspaceDatabases() {
  const payload = await request('/workspace-databases', { method: 'GET', cache: 'no-store' })
  return payload.databases || []
}

export async function createWorkspaceDatabase(input) {
  return request('/workspace-databases', {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export async function fetchWorkspaceDatabase(databaseId) {
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function updateWorkspaceDatabase(databaseId, updates) {
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}`, {
    method: 'PATCH',
    body: JSON.stringify(updates)
  })
}

export async function deleteWorkspaceDatabase(databaseId) {
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}`, {
    method: 'DELETE'
  })
}

export async function createWorkspaceDatabaseProperty(databaseId, property) {
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}/properties`, {
    method: 'POST',
    body: JSON.stringify(property)
  })
}

export async function updateWorkspaceDatabaseProperty(databaseId, propertyId, updates) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/properties/${id(propertyId, '属性 ID')}`,
    { method: 'PATCH', body: JSON.stringify(updates) }
  )
}

export async function deleteWorkspaceDatabaseProperty(databaseId, propertyId) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/properties/${id(propertyId, '属性 ID')}`,
    { method: 'DELETE' }
  )
}

export async function createWorkspaceDatabaseView(databaseId, view) {
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}/views`, {
    method: 'POST',
    body: JSON.stringify(view)
  })
}

export async function updateWorkspaceDatabaseView(databaseId, viewId, updates) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/views/${id(viewId, '视图 ID')}`,
    { method: 'PATCH', body: JSON.stringify(updates) }
  )
}

export async function deleteWorkspaceDatabaseView(databaseId, viewId) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/views/${id(viewId, '视图 ID')}`,
    { method: 'DELETE' }
  )
}

export async function fetchWorkspaceDatabaseRows(databaseId, {
  viewId = '',
  includeArchived = false
} = {}) {
  const params = new URLSearchParams()
  if (viewId) params.set('viewId', viewId)
  if (includeArchived) params.set('includeArchived', '1')
  const suffix = params.size ? `?${params}` : ''
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}/rows${suffix}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function createWorkspaceDatabaseRow(databaseId, row) {
  return request(`/workspace-databases/${id(databaseId, '数据库 ID')}/rows`, {
    method: 'POST',
    body: JSON.stringify(row)
  })
}

export async function updateWorkspaceDatabaseRow(databaseId, rowId, updates) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/rows/${id(rowId, '记录 ID')}`,
    { method: 'PATCH', body: JSON.stringify(updates) }
  )
}

export async function archiveWorkspaceDatabaseRow(databaseId, rowId) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/rows/${id(rowId, '记录 ID')}`,
    { method: 'DELETE' }
  )
}

export async function restoreWorkspaceDatabaseRow(databaseId, rowId) {
  return request(
    `/workspace-databases/${id(databaseId, '数据库 ID')}/rows/${id(rowId, '记录 ID')}/restore`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}
