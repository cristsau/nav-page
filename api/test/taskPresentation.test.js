import test from 'node:test'
import assert from 'node:assert/strict'
import { taskGroup, taskCounts, taskProgress, remainingTime, transferBytes, uploadLabel, offlineTransferStages, taskGuidance, taskParentDirectory, visibleTasks } from '../../app/src/modules/files/taskPresentation.js'
import { FileTransferQueue } from '../../app/src/modules/files/fileTransfers.js'

test('task search combines status with case-insensitive filename and destination terms', () => {
  const jobs = [{ name: 'MOVIE.MP4', destination: '/旅行/电影', state: 'complete' }, { name: 'movie.mp4', path: '/工作', state: 'paused' }, { name: '笔记.md', state: 'queued' }]
  const before = structuredClone(jobs)
  assert.deepEqual(visibleTasks(jobs, 'all', 'ＭＯＶＩＥ 旅行'), [jobs[0]])
  assert.deepEqual(visibleTasks(jobs, 'attention', 'MOVIE'), [jobs[1]])
  assert.deepEqual(visibleTasks(jobs, 'all', '  \n '), jobs)
  assert.deepEqual(jobs, before)
})
test('task search is literal, bounded and does not inspect source URLs, errors or private fields', () => {
  const job = { name: '[a].mp4', state: 'review', url: 'https://example.com/private-source', error: 'private-error', token: 'private-token' }
  assert.deepEqual(visibleTasks([job], 'attention', '[a]'), [job])
  for (const query of ['private-source', 'private-error', 'private-token', '.*', 'x'.repeat(10000)]) assert.equal(visibleTasks([job], 'all', query).length, 0)
  assert.deepEqual(visibleTasks([{ state: 'queued' }], 'all', ''), [{ state: 'queued' }])
})

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

test('unknown and invalid transfer sizes remain indeterminate, not a misleading zero percent', () => {
  for (const size of [null, undefined, 0, -1, NaN, Infinity]) {
    const stages = offlineTransferStages({ state: 'queued', size, downloaded: 0, uploaded: 0 })
    assert.deepEqual(stages.map(s => s.progress), [null, null])
    assert.deepEqual(stages.map(s => s.text), ['大小待获取', '大小待获取'])
  }
  assert.deepEqual(offlineTransferStages({ state: 'uploading', size: 100, downloaded: 100, uploaded: 25 }).map(s => s.progress), [100, 25])
})
test('video source and output use separate totals; conversion never invents a percentage', () => {
  const job = { kind: 'video', state: 'downloading', stage: 'transcoding', sourceSize: 200, size: 50, downloaded: 200, uploaded: 0 }
  assert.deepEqual(offlineTransferStages(job).map(s => s.progress), [100, null])
  assert.equal(offlineTransferStages(job)[1].text, '等待兼容副本')
  assert.deepEqual(offlineTransferStages({ ...job, state: 'uploading', uploaded: 25 }).map(s => s.progress), [100, 50])
  assert.deepEqual(offlineTransferStages({ ...job, state: 'complete' }).map(s => s.progress), [100, 100])
})
test('guidance keeps requested intent, commit uncertainty and completion distinct', () => {
  assert.match(taskGuidance({ state: 'downloading', intent: 'pause' }), /等待节点确认/)
  assert.match(taskGuidance({ state: 'uploading', intent: 'cancel' }), /在途传输/)
  assert.match(taskGuidance({ state: 'committing' }), /还不能算完成/)
  assert.match(taskGuidance({ state: 'review', intent: 'cancel' }), /不要重复创建/)
  assert.match(taskGuidance({ state: 'complete', intent: 'pause' }), /网盘已确认/)
  assert.equal(taskGuidance({ state: 'future-state' }), '')
})
test('open-folder destinations are local Dropbox paths, never external navigation or traversal', () => {
  assert.equal(taskParentDirectory('/movie.mp4'), '')
  assert.equal(taskParentDirectory('/旅行/电影.mp4'), '/旅行')
  for (const value of [null, '', '/', '/folder/', '//host/file', '/a/../b', '/a/./b', '/a\\b', '/a\nb', 'https://example.com/a']) {
    assert.equal(taskParentDirectory(value), null)
  }
})
