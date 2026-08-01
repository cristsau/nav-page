export function mapGroup(record) {
  if (!record) return null

  return {
    id: record.id,
    name: record.name,
    icon: record.icon,
    color: record.color,
    order: record.display_order,
    collapsed: record.collapsed,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}

export function mapBookmark(record) {
  if (!record) return null

  return {
    id: record.id,
    groupId: record.group_id,
    title: record.title,
    url: record.url,
    favicon: record.favicon,
    description: record.description,
    tags: Array.isArray(record.tags) ? record.tags : [],
    order: record.display_order,
    healthStatus: record.health_status || 'unchecked',
    healthHttpStatus: Number.isInteger(record.health_http_status)
      ? record.health_http_status
      : null,
    healthCheckedAt: record.health_checked_at || null,
    healthFailureCount: Number(record.health_failure_count || 0),
    healthErrorCode: record.health_error_code || null,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}
