export function mapCustomSearchEngine(record) {
  if (!record) return null

  return {
    id: record.id,
    name: record.name,
    icon: record.icon,
    url: record.url,
    order: record.display_order,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }
}
