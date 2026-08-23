export const MIN_DATA_RESTORE_NOTE_NUMBER_ID = 1000
export const MAX_DATA_RESTORE_NOTE_NUMBER_ID = 999999999999999
export const MAX_DATA_RESTORE_NOTE_NUMBER_ADVANCE = 100000

function toSafeInteger(value, label, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === '')) {
    return null
  }

  const number = Number(value)
  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`${label} 必须是安全整数`)
  }
  return number
}

export function normalizeDataRestoreNoteNumberId(value) {
  const numberId = toSafeInteger(value, '笔记数字 ID', { allowNull: true })
  if (numberId === null) return null
  return numberId >= MIN_DATA_RESTORE_NOTE_NUMBER_ID
    && numberId <= MAX_DATA_RESTORE_NOTE_NUMBER_ID
    ? numberId
    : null
}

export function planDataRestoreNoteNumbers(notes = [], {
  sequenceLastValue,
  sequenceIsCalled,
  currentMaximum,
  maximumAdvance = MAX_DATA_RESTORE_NOTE_NUMBER_ADVANCE
} = {}) {
  if (!Array.isArray(notes)) throw new TypeError('恢复笔记必须是数组')

  const sequenceLast = toSafeInteger(sequenceLastValue, '笔记数字 ID 序列')
  const currentMax = toSafeInteger(currentMaximum, '当前最大笔记数字 ID', {
    allowNull: true
  })
  const allowedAdvance = toSafeInteger(maximumAdvance, '笔记数字 ID 最大前移量')
  if (allowedAdvance < notes.length || allowedAdvance < 1) {
    throw new TypeError('笔记数字 ID 最大前移量过小')
  }

  const sequenceHighWater = sequenceIsCalled === true
    ? sequenceLast
    : sequenceLast - 1
  const baseHighWater = Math.max(
    MIN_DATA_RESTORE_NOTE_NUMBER_ID - 1,
    sequenceHighWater,
    currentMax ?? (MIN_DATA_RESTORE_NOTE_NUMBER_ID - 1)
  )
  const maximumAllowed = Math.min(
    MAX_DATA_RESTORE_NOTE_NUMBER_ID,
    baseHighWater + allowedAdvance
  )
  const explicitIds = new Set()

  for (const note of notes) {
    const numberId = normalizeDataRestoreNoteNumberId(note?.numberId)
    if (note?.numberId !== null && note?.numberId !== undefined && note?.numberId !== '' && numberId === null) {
      throw new TypeError(
        `恢复的笔记数字 ID 必须是 ${MIN_DATA_RESTORE_NOTE_NUMBER_ID} 到 ${MAX_DATA_RESTORE_NOTE_NUMBER_ID} 之间的整数`
      )
    }
    if (numberId !== null) {
      if (explicitIds.has(numberId)) throw new TypeError('恢复数据包含重复的笔记数字 ID')
      explicitIds.add(numberId)
    }
  }

  const highestExplicit = explicitIds.size ? Math.max(...explicitIds) : baseHighWater
  if (highestExplicit > maximumAllowed) {
    throw new RangeError(
      `备份中的笔记数字 ID 超出当前序列允许的安全前移范围（最多 ${allowedAdvance}）`
    )
  }

  let candidate = baseHighWater
  const numberIds = notes.map((note) => {
    const explicit = normalizeDataRestoreNoteNumberId(note?.numberId)
    if (explicit !== null) return explicit

    do {
      candidate += 1
    } while (explicitIds.has(candidate))

    if (candidate > maximumAllowed || candidate > MAX_DATA_RESTORE_NOTE_NUMBER_ID) {
      throw new RangeError('没有足够的安全笔记数字 ID 可用于本次恢复')
    }
    explicitIds.add(candidate)
    return candidate
  })
  const highWater = Math.max(baseHighWater, ...numberIds)

  return {
    numberIds,
    baseHighWater,
    highWater,
    shouldAdvanceSequence: highWater > sequenceHighWater
  }
}
