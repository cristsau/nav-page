import test from 'node:test'
import assert from 'node:assert/strict'
import { healthResultKey, normalizeHealthDismissals, dismissHealthResults, isHealthProblem } from '../../app/src/modules/navigation/navigationHealth.js'
const sample = { id: 'bookmark-a', healthStatus: 'broken', healthCheckedAt: '2026-09-11T07:00:00Z', healthFailureCount: 2 }

test('dismissal acknowledges a check without changing or deleting bookmarks', () => {
  const bookmark = Object.freeze({ ...sample })
  const result = dismissHealthResults([], [bookmark], [bookmark])
  assert.deepEqual(result, [healthResultKey(bookmark)])
  assert.equal(bookmark.healthStatus, 'broken')
  assert.equal(bookmark.id, 'bookmark-a')
})
test('new check, status, failure count or error makes the acknowledgement stale', () => {
  const dismissed = [healthResultKey(sample)]
  for (const change of [{ healthCheckedAt: '2026-09-12T07:00:00Z' }, { healthStatus: 'suspect' }, { healthFailureCount: 3 }, { healthErrorCode: 'timeout' }, { healthHttpStatus: 500 }]) {
    assert.deepEqual(normalizeHealthDismissals(dismissed, [{ ...sample, ...change }]), [])
  }
})
test('ignore malformed, duplicate, deleted and other-user bookmark acknowledgements', () => {
  assert.deepEqual(normalizeHealthDismissals({ invalid: true }, [sample]), [])
  assert.deepEqual(normalizeHealthDismissals([null, 42, 'other-user', healthResultKey(sample), healthResultKey(sample)], [sample]), [healthResultKey(sample)])
  assert.deepEqual(normalizeHealthDismissals([healthResultKey(sample)], []), [])
})
test('only suspect, broken and unsupported results are attention items', () => {
  for (const healthStatus of ['healthy', 'redirected', 'protected', 'throttled', 'unchecked']) {
    const bookmark = { ...sample, healthStatus }
    assert.equal(isHealthProblem(bookmark), false)
    assert.deepEqual(dismissHealthResults([], [bookmark], [bookmark]), [])
  }
})
test('individual dismissal preserves other results; clearing acknowledgements restores attention', () => {
  const other = { ...sample, id: 'bookmark-b' }
  assert.deepEqual(dismissHealthResults([], [sample, other], [sample]), [healthResultKey(sample)])
  assert.deepEqual(normalizeHealthDismissals([], [sample, other]), [])
})
