import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePinnedGroupIds } from '../../app/src/modules/navigation/navigationManagement.js'
import { resolveNoteSaveState } from '../../app/src/modules/whisper/utils/noteSaveState.js'

test('pinned groups are bounded, ordered, unique and restricted to the loaded account groups', () => {
  const groups = Array.from({ length: 30 }, (_, index) => ({ id: `g${index}` }))
  assert.deepEqual(normalizePinnedGroupIds(['g2', 'foreign', 'g2', 'g1'], groups), ['g2', 'g1'])
  assert.deepEqual(normalizePinnedGroupIds(null, groups), [])
  assert.deepEqual(normalizePinnedGroupIds(['g1'], []), [])
  assert.equal(normalizePinnedGroupIds(groups.map((group) => group.id), groups).length, 20)
})

test('note save receipts distinguish cloud confirmation from local queued, failed and conflicting changes', () => {
  assert.match(resolveNoteSaveState({ id: 'n', syncState: 'pending' }).message, /本机.*待同步/)
  assert.equal(resolveNoteSaveState({ syncState: 'conflict' }).state, 'conflict')
  assert.equal(resolveNoteSaveState({ syncState: 'failed' }).state, 'error')
  assert.match(resolveNoteSaveState({ syncState: 'synced' }).message, /云端/)
  assert.match(resolveNoteSaveState({}, false).message, /本地模式/)
  for (const syncState of ['pending', 'conflict', 'failed']) {
    assert.doesNotMatch(resolveNoteSaveState({ syncState }).message, /已保存到云端/)
  }
})
