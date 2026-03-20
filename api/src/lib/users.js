export function sanitizeUser(user) {
  if (!user) return null

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    approvedAt: user.approved_at,
    lastLoginAt: user.last_login_at
  }
}

export function mapRegistrationRequest(record) {
  if (!record) return null

  return {
    id: record.id,
    username: record.username,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    decidedAt: record.decided_at,
    decidedBy: record.decided_by
  }
}
