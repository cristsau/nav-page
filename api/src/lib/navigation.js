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
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}
