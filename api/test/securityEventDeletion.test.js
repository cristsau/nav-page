import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSecurityEventDeletion } from '../src/lib/securityEventDeletion.js'

test('security event deletion accepts unique positive BIGINT IDs and current password', () => {
  assert.deepEqual(validateSecurityEventDeletion({
    currentPassword: 'current-secret',
    eventIds: ['2', 3, '2', '9223372036854775807']
  }), {
    valid: true,
    currentPassword: 'current-secret',
    eventIds: ['2', '3', '9223372036854775807']
  })
})

test('security event deletion rejects missing passwords, invalid IDs, overflow, and oversized batches', () => {
  assert.deepEqual(validateSecurityEventDeletion({ eventIds: ['1'] }), {
    valid: false,
    error: 'Current password is required'
  })

  for (const eventIds of [
    [],
    ['0'],
    ['-1'],
    ['1.5'],
    ['9223372036854775808']
  ]) {
    assert.equal(validateSecurityEventDeletion({
      currentPassword: 'current-secret',
      eventIds
    }).valid, false)
  }

  assert.equal(validateSecurityEventDeletion({
    currentPassword: 'current-secret',
    eventIds: Array.from({ length: 101 }, (_, index) => String(index + 1))
  }).valid, false)
})
