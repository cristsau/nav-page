import test from 'node:test'
import assert from 'node:assert/strict'
import { taskGroup, taskCounts, taskProgress, remainingTime, transferBytes, uploadLabel } from '../../app/src/modules/files/taskPresentation.js'
import { FileTransferQueue } from '../../app/src/modules/files/fileTransfers.js'

test('task groups keep uncertain and unknown work visible as attention, never completed', () => {
  const states = ['queued', 'checking', 'downloading', 'uploading', 'committing', 'paused', 'awaiting_file', 'error', 'review', 'future-state', 'complete', 'cancelled']
  assert.deepEqual(taskCounts(states.map(state => ({ state }))), { all: 12, active: 5, attention: 5, finished: 2 })
  assert.equal(taskGroup({ state: 'review', offset: 100, size: 100 }), 'attention')
})
test('progress has bounded numeric values and handles empty/unknown files', () => {
  assert.equal(taskProgress(-5, 10), 0)
  assert.equal(taskProgress(20, 10), 100)
  assert.equal(taskProgress(NaN, 10), 0)
  assert.equal(taskProgress(0, null), 0)
  assert.equal(taskProgress(0, 0), 0)
  assert.equal(taskProgress(0, 0, true), 100)
  assert.equal(taskProgress(8, 9), 88)
})
test('byte completion is still commit verification, not completed upload', () => {
  assert.equal(uploadLabel({ state: 'uploading', offset: 9, size: 9 }), '提交校验中')
  assert.equal(uploadLabel({ state: 'complete' }), '上传完成')
  assert.equal(uploadLabel({ state: 'checking', pause: true }), '正在暂停…')
  assert.equal(uploadLabel({ state: 'queued', cancel: true }), '正在取消…')
  assert.equal(uploadLabel({ state: 'review', cancel: true }), '请核对云端结果')
})
test('readable transfer timing never presents an invalid or negative ETA', () => {
  assert.equal(remainingTime(100, 0), '')
  assert.equal(remainingTime(-1, 2), '')
  assert.equal(remainingTime(60, 2), '约 30 秒')
  assert.equal(remainingTime(121, 2), '约 2 分钟')
  assert.equal(remainingTime(7200, 1), '约 2.0 小时')
  assert.equal(transferBytes(null), '待获取')
  assert.equal(transferBytes(0), '0 B')
  assert.equal(transferBytes(1024 ** 3), '1.0 GB')
})
test('clear completed records preserves review, error, paused and awaiting-file work and does not call provider', async () => {
  let calls = 0, emitted
  const queue = new FileTransferQueue({ action: () => calls++, chunk: () => calls++, changed: next => { emitted = next } })
  queue.jobs = ['complete', 'review', 'cancelled', 'error', 'paused', 'awaiting_file'].map((state, id) => ({ state, id, file: null }))
  await queue.clearFinished()
  assert.deepEqual(queue.jobs.map(j => j.state), ['review', 'error', 'paused', 'awaiting_file'])
  assert.deepEqual(emitted.map(j => j.state), ['review', 'error', 'paused', 'awaiting_file'])
  assert.equal(calls, 0)
})
