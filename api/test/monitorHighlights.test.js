import test from 'node:test'
import assert from 'node:assert/strict'
import { monitorHighlights } from '../../app/src/modules/monitor/monitorHighlights.js'

test('overview highlights compare live resource percentages and billing-cycle traffic bytes', () => {
  const nodes = [
    { id: 1, online: true, fresh: true, cpu: 65, memory: 20, trafficUsed: 800, trafficPercent: 10 },
    { id: 2, online: true, fresh: true, cpu: 10, memory: 80, trafficUsed: 100, trafficPercent: 90 },
    { id: 3, online: true, fresh: true, cpu: 20, memory: 40, trafficUsed: 1200, trafficPercent: null },
    { id: 4, online: false, fresh: false, cpu: 99, memory: 99, trafficUsed: null },
    { id: 5, online: true, fresh: false, cpu: 100, memory: 100, trafficUsed: null }
  ]
  const before = structuredClone(nodes)
  assert.deepEqual(monitorHighlights(nodes).map(h => [h.key, h.node.id, h.value]), [
    ['cpu', 1, 65], ['memory', 2, 80], ['trafficUsed', 3, 1200]
  ])
  assert.deepEqual(nodes, before)
})

test('missing or invalid data remains unknown, while actual zero readings are eligible', () => {
  for (const nodes of [[], [{ id: 1, online: true, fresh: true, cpu: null, memory: NaN, trafficUsed: undefined }],
    [{ id: 2, online: true, fresh: true, cpu: Infinity, memory: -1, trafficUsed: '0' }]]) {
    assert.ok(monitorHighlights(nodes).every(h => h.node === null && h.value === null))
  }
  assert.ok(monitorHighlights([{ id: 1, online: true, fresh: true, cpu: 0, memory: 0, trafficUsed: 0 }])
    .every(h => h.node.id === 1 && h.value === 0))
})

test('equal readings keep a stable winner across refresh order, and refreshed readings replace it', () => {
  const nodes = [2, 1].map(id => ({ id, online: true, fresh: true, cpu: 40, memory: 50, trafficUsed: 100 }))
  assert.ok(monitorHighlights(nodes).every(h => h.node.id === 1))
  assert.ok(monitorHighlights([...nodes].reverse()).every(h => h.node.id === 1))
  assert.equal(monitorHighlights([{ ...nodes[0], cpu: 60 }, nodes[1]])[0].node.id, 2)
})
