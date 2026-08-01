import { query, withTransaction } from '../db/index.js'

const DEFAULT_REMINDER_LIMIT = 50
const MAX_REMINDER_LIMIT = 100

export function normalizeReminderLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REMINDER_LIMIT
  return Math.min(parsed, MAX_REMINDER_LIMIT)
}

export function isValidReminderId(value) {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(value || ''))
}

export function mapNoteReminder(record) {
  if (!record) return null

  return {
    id: record.id,
    noteId: record.note_id,
    numberId: record.number_id === null || record.number_id === undefined
      ? null
      : Number(record.number_id),
    title: record.encrypted
      ? '加密备忘录'
      : String(record.title || '未命名备忘录'),
    encrypted: Boolean(record.encrypted),
    dueAt: record.due_at_snapshot,
    triggeredAt: record.triggered_at,
    readAt: record.read_at || null
  }
}

export async function syncDueNoteReminders(client, userId) {
  await client.query(
    `
      DELETE FROM note_reminders AS reminder
      USING notes AS note
      WHERE reminder.user_id = $1
        AND reminder.note_id = note.id
        AND (
          note.user_id <> reminder.user_id
          OR note.type <> 'memo'
          OR note.completed = TRUE
          OR note.due_at IS NULL
          OR note.due_at IS DISTINCT FROM reminder.due_at_snapshot
        )
    `,
    [userId]
  )

  await client.query(
    `
      INSERT INTO note_reminders (
        user_id,
        note_id,
        due_at_snapshot,
        triggered_at
      )
      SELECT
        note.user_id,
        note.id,
        note.due_at,
        NOW()
      FROM notes AS note
      WHERE note.user_id = $1
        AND note.type = 'memo'
        AND note.completed = FALSE
        AND note.due_at IS NOT NULL
        AND note.due_at <= NOW()
      ON CONFLICT (note_id, due_at_snapshot) DO NOTHING
    `,
    [userId]
  )
}

export async function getNoteRemindersForUser(userId, {
  limit = DEFAULT_REMINDER_LIMIT,
  transaction = withTransaction
} = {}) {
  const normalizedLimit = normalizeReminderLimit(limit)

  return transaction(async (client) => {
    await syncDueNoteReminders(client, userId)

    const remindersResult = await client.query(
      `
        SELECT
          reminder.id,
          reminder.note_id,
          reminder.due_at_snapshot,
          reminder.triggered_at,
          reminder.read_at,
          note.number_id,
          note.title,
          note.encrypted
        FROM note_reminders AS reminder
        JOIN notes AS note
          ON note.id = reminder.note_id
         AND note.user_id = reminder.user_id
        WHERE reminder.user_id = $1
          AND note.type = 'memo'
          AND note.completed = FALSE
          AND note.due_at IS NOT NULL
          AND note.due_at = reminder.due_at_snapshot
        ORDER BY
          (reminder.read_at IS NULL) DESC,
          reminder.due_at_snapshot DESC,
          reminder.triggered_at DESC
        LIMIT $2
      `,
      [userId, normalizedLimit]
    )
    const unreadResult = await client.query(
      `
        SELECT COUNT(*)::integer AS count
        FROM note_reminders AS reminder
        JOIN notes AS note
          ON note.id = reminder.note_id
         AND note.user_id = reminder.user_id
        WHERE reminder.user_id = $1
          AND reminder.read_at IS NULL
          AND note.type = 'memo'
          AND note.completed = FALSE
          AND note.due_at IS NOT NULL
          AND note.due_at = reminder.due_at_snapshot
      `,
      [userId]
    )

    return {
      reminders: remindersResult.rows.map(mapNoteReminder),
      unreadCount: Number(unreadResult.rows[0]?.count || 0),
      serverNow: new Date().toISOString()
    }
  })
}

export async function markNoteReminderRead(userId, reminderId, {
  dbQuery = query
} = {}) {
  const { rows } = await dbQuery(
    `
      UPDATE note_reminders
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1
        AND user_id = $2
      RETURNING id, read_at
    `,
    [reminderId, userId]
  )

  return rows[0] || null
}

export async function markAllNoteRemindersRead(userId, {
  dbQuery = query
} = {}) {
  const result = await dbQuery(
    `
      UPDATE note_reminders
      SET read_at = NOW()
      WHERE user_id = $1
        AND read_at IS NULL
    `,
    [userId]
  )

  return Number(result.rowCount || 0)
}
