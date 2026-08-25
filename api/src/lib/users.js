export function sanitizeUser(user) {
  if (!user) return null

  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    emailVerifiedAt: user.email_verified_at || null,
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
    email: record.email || '',
    emailVerifiedAt: record.email_verified_at || null,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    decidedAt: record.decided_at,
    decidedBy: record.decided_by
  }
}
