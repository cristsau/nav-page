import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeVisibleOrder } from '../../app/src/modules/monitor/monitorOrder.js'
import { monitorAlerts } from '../../app/src/modules/monitor/monitorAlerts.js'

test('filtered reordering preserves every hidden slot and never mutates input', () => {
  const all = [1, 2, 3, 4, 5], visible = [5, 3, 1]
  assert.deepEqual(mergeVisibleOrder(all, visible, [3, 5, 1]), [3, 2, 5, 4, 1])
  assert.deepEqual(all, [1, 2, 3, 4, 5]); assert.deepEqual(visible, [5, 3, 1])
  assert.deepEqual(mergeVisibleOrder(all, [], []), all)
})
test('invalid or changed node sets cannot produce a partial order write', () => {
  for (const [all, visible, reordered] of [
    [[1, 2], [1, 2], [1]], [[1, 2], [1, 2], [1, 1]], [[1, 2], [1, 2], [1, 3]],
    [[1, 2], [1, 3], [3, 1]], [[1, 1], [1], [1]], [[1, 2], [1, 1], [1, 1]]
  ]) assert.throws(() => mergeVisibleOrder(all, visible, reordered))
})
test('existing alerts disclose exact expiry, traffic and capacity, with urgent items first', () => {
  const nodes = [{ id: 1, name: 'A', expiryDays: 22 }, { id: 2, name: 'B', fresh: true, memory: 91.2, disk: 90 },
    { id: 3, name: 'C', trafficPercent: 85.34 }, { id: 4, name: 'D', expiryDays: -2 }]
  const alerts = [{ nodeId: 1, kind: 'expiry' }, { nodeId: 2, kind: 'capacity' }, { nodeId: 3, kind: 'traffic' },
    { nodeId: 4, kind: 'expiry' }, { nodeId: 5, kind: 'offline', text: '已离线' }]
  const result = monitorAlerts(alerts, nodes)
  assert.deepEqual(result.map(a => a.reason), ['已过期 2 天', '已离线', '内存 91.2% · 磁盘 90.0%', '流量已用 85.3%', '22 天后到期'])
  assert.equal(result[1].name, '服务器 #5')
  assert.deepEqual(monitorAlerts([], nodes), [])
  assert.equal(monitorAlerts([{ nodeId: 2, kind: 'capacity', text: 'B 指标待更新' }], [{ ...nodes[1], fresh: false }])[0].reason, '指标待更新')
})
