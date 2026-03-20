import { query } from '../db/index.js'

export async function getUserSettingRecord(userId, key) {
  const { rows } = await query(
    `
      SELECT key, value, updated_at
      FROM user_settings
      WHERE user_id = $1
        AND key = $2
      LIMIT 1
    `,
    [userId, key]
  )

  return rows[0] || null
}

export async function getUserSettingValue(userId, key, fallback = null) {
  const record = await getUserSettingRecord(userId, key)
  return record ? record.value : fallback
}

export async function setUserSettingValue(userId, key, value) {
  const { rows } = await query(
    `
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (user_id, key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING key, value, updated_at
    `,
    [userId, key, JSON.stringify(value)]
  )

  return rows[0]
}
