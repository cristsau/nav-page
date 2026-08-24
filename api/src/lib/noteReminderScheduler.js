export const NOTE_REMINDER_GENERATION_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_note_reminder_generation')
  ) AS acquired
`

export const NOTE_REMINDER_GENERATION_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_note_reminder_generation')
  ) AS released
`

export const GENERATE_DUE_NOTE_REMINDERS_SQL = `
  WITH candidates AS (
    SELECT
      note.id,
      note.user_id,
      note.due_at,
      note.remind_before_minutes,
      note.due_at - (note.remind_before_minutes * INTERVAL '1 minute') AS reminder_at
    FROM notes AS note
    WHERE note.type = 'memo'
      AND note.completed = FALSE
      AND note.due_at IS NOT NULL
      AND note.due_at - (note.remind_before_minutes * INTERVAL '1 minute') <= NOW()
      AND NOT EXISTS (
        SELECT 1
        FROM note_reminders AS reminder
        WHERE reminder.note_id = note.id
          AND reminder.due_at_snapshot = note.due_at
      )
    ORDER BY reminder_at ASC, note.id ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  INSERT INTO note_reminders (
    user_id,
    note_id,
    due_at_snapshot,
    remind_before_minutes_snapshot,
    reminder_at_snapshot,
    triggered_at
  )
  SELECT
    user_id,
    id,
    due_at,
    remind_before_minutes,
    reminder_at,
    NOW()
  FROM candidates
  ON CONFLICT (note_id, due_at_snapshot) DO NOTHING
  RETURNING id
`

const MIN_INTERVAL_SECONDS = 30
const MAX_INTERVAL_SECONDS = 24 * 60 * 60
const MAX_BATCH_SIZE = 1_000
const STARTUP_DELAY_MS = 10_000

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function validateNoteReminderSchedulerPolicy({ intervalSeconds, batchSize }) {
  return {
    intervalSeconds: boundedInteger(
      intervalSeconds,
      'intervalSeconds',
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS
    ),
    batchSize: boundedInteger(batchSize, 'batchSize', 1, MAX_BATCH_SIZE)
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try {
    await observer?.[method]?.(payload)
  } catch (error) {
    logger?.warn?.(
      { err: error, observerMethod: method },
      'note reminder generation status could not be recorded'
    )
  }
}

export async function generateDueNoteReminders({ poolInstance, policy }) {
  const validated = validateNoteReminderSchedulerPolicy(policy)
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }

  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  try {
    const lock = await client.query(NOTE_REMINDER_GENERATION_LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return { generated: 0, skipped: 'already-running' }

    const result = await client.query(GENERATE_DUE_NOTE_REMINDERS_SQL, [
      validated.batchSize
    ])
    return { generated: Number(result.rowCount || 0), skipped: null }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(NOTE_REMINDER_GENERATION_UNLOCK_SQL)
      } catch (error) {
        unlockError = error
      }
    }
    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

export function startNoteReminderGeneration({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  generateFn = generateDueNoteReminders,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateNoteReminderSchedulerPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => generateFn({ poolInstance, policy: validated }))
      .then(async (result) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'succeeded', {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        return result
      })
      .catch(async (error) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'failed', {
          error,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        logger?.error?.(error, 'failed to generate note reminders')
      })
      .finally(() => {
        activeRun = null
      })
    return activeRun
  }

  const intervalMs = validated.intervalSeconds * 1_000
  timeoutHandle = timerApi.setTimeout(() => {
    void run()
    intervalHandle = timerApi.setInterval(() => void run(), intervalMs)
    intervalHandle?.unref?.()
  }, Math.min(STARTUP_DELAY_MS, intervalMs))
  timeoutHandle?.unref?.()

  return async () => {
    stopped = true
    if (timeoutHandle) timerApi.clearTimeout(timeoutHandle)
    if (intervalHandle) timerApi.clearInterval(intervalHandle)
    if (activeRun) await activeRun
  }
}
