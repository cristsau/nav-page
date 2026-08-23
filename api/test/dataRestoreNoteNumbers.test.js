import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DATA_RESTORE_NOTE_NUMBER_ADVANCE,
  MAX_DATA_RESTORE_NOTE_NUMBER_ID,
  normalizeDataRestoreNoteNumberId,
  planDataRestoreNoteNumbers
} from '../src/lib/dataRestoreNoteNumbers.js'

test('mixed explicit and missing note numbers are assigned without collisions', () => {
  const plan = planDataRestoreNoteNumbers([
    { numberId: 1005 },
    { numberId: null },
    { numberId: 1007 },
    {},
    { numberId: 1006 }
  ], {
    sequenceLastValue: '1004',
    sequenceIsCalled: true,
    currentMaximum: '1004'
  })

  assert.deepEqual(plan.numberIds, [1005, 1008, 1007, 1009, 1006])
  assert.equal(plan.highWater, 1009)
  assert.equal(plan.shouldAdvanceSequence, true)
})

test('normal database note IDs remain exportable through the schema maximum', () => {
  assert.equal(
    normalizeDataRestoreNoteNumberId(MAX_DATA_RESTORE_NOTE_NUMBER_ID),
    MAX_DATA_RESTORE_NOTE_NUMBER_ID
  )
  assert.equal(normalizeDataRestoreNoteNumberId(MAX_DATA_RESTORE_NOTE_NUMBER_ID + 1), null)
})

test('an imported note cannot make a large global sequence jump', () => {
  assert.throws(
    () => planDataRestoreNoteNumbers([
      { numberId: 1000 + MAX_DATA_RESTORE_NOTE_NUMBER_ADVANCE + 1 }
    ], {
      sequenceLastValue: '1000',
      sequenceIsCalled: false,
      currentMaximum: null
    }),
    /安全前移范围/
  )
})

test('planning is pure and does not consume a database sequence', () => {
  const state = {
    sequenceLastValue: '1010',
    sequenceIsCalled: true,
    currentMaximum: '1008'
  }
  const first = planDataRestoreNoteNumbers([{}, {}], state)
  const second = planDataRestoreNoteNumbers([{}, {}], state)

  assert.deepEqual(first, second)
  assert.deepEqual(first.numberIds, [1011, 1012])
})
