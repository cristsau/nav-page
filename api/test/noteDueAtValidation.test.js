import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  normalizeOptionalTimestamp,
  resolveNoteDueAt
} from '../src/routes/notes.js'

test('undefined dueAt preserves the caller fallback while null and blank values explicitly clear it', () => {
  const fallback = new Date('2026-08-01T00:00:00.000Z')

  assert.deepEqual(normalizeOptionalTimestamp(undefined, fallback), {
    valid: true,
    value: fallback
  })
  assert.deepEqual(normalizeOptionalTimestamp(null, fallback), {
    valid: true,
    value: null
  })
  assert.deepEqual(normalizeOptionalTimestamp('', fallback), {
    valid: true,
    value: null
  })
  assert.deepEqual(normalizeOptionalTimestamp('   ', fallback), {
    valid: true,
    value: null
  })
})

test('valid ISO timestamps with an explicit timezone normalize to UTC', () => {
  assert.deepEqual(normalizeOptionalTimestamp('2026-08-01T08:30:00+08:00'), {
    valid: true,
    value: '2026-08-01T00:30:00.000Z'
  })
  assert.deepEqual(normalizeOptionalTimestamp('2026-08-01T00:30:00.125Z'), {
    valid: true,
    value: '2026-08-01T00:30:00.125Z'
  })
})

test('malformed, ambiguous, impossible, and non-string dueAt values are invalid', () => {
  const invalidValues = [
    'not-a-date',
    '2026-08-01',
    '2026-08-01T08:30:00',
    '2026-02-30T08:30:00Z',
    '2026-08-01T24:00:00Z',
    '2026-08-01T08:30:00+14:30',
    0,
    false,
    {}
  ]

  for (const value of invalidValues) {
    assert.deepEqual(normalizeOptionalTimestamp(value, 'preserve-me'), {
      valid: false,
      value: null
    })
  }
})

test('memo create and update distinguish omission, clearing, valid values, and invalid values', () => {
  const existingDueAt = '2026-08-01T00:30:00.000Z'

  assert.deepEqual(resolveNoteDueAt('memo', undefined), {
    valid: true,
    value: null
  })
  assert.deepEqual(resolveNoteDueAt('memo', undefined, existingDueAt), {
    valid: true,
    value: existingDueAt
  })
  assert.deepEqual(resolveNoteDueAt('memo', null, existingDueAt), {
    valid: true,
    value: null
  })
  assert.deepEqual(resolveNoteDueAt('memo', '2026-08-02T08:00:00+08:00', existingDueAt), {
    valid: true,
    value: '2026-08-02T00:00:00.000Z'
  })
  assert.deepEqual(resolveNoteDueAt('memo', 'invalid', existingDueAt), {
    valid: false,
    value: null
  })
})

test('diary create and update ignore dueAt even when the supplied value is invalid', () => {
  assert.deepEqual(resolveNoteDueAt('diary', 'invalid'), {
    valid: true,
    value: null
  })
  assert.deepEqual(resolveNoteDueAt('diary', 'invalid', '2026-08-01T00:30:00.000Z'), {
    valid: true,
    value: null
  })
})

test('memo create and update reject invalid dueAt while diary requests ignore it', async () => {
  const source = await fs.readFile(
    new URL('../src/routes/notes.js', import.meta.url),
    'utf8'
  )

  assert.equal((source.match(/const dueAtResult = resolveNoteDueAt\(/g) || []).length, 2)
  assert.equal((source.match(/if \(!dueAtResult\.valid\)/g) || []).length, 2)
  assert.match(source, /code: 'invalid_due_at'/)
  assert.match(source, /resolveNoteDueAt\(type, request\.body\?\.dueAt\)/)
  assert.match(source, /resolveNoteDueAt\(type, request\.body\?\.dueAt, existing\.due_at\)/)
  assert.match(source, /updated_at::text AS updated_at_version/)
  assert.match(source, /AND updated_at = \$15::timestamptz/)
  assert.match(source, /code: 'stale_note'/)
})
