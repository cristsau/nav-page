// CPU/memory compare live percentages. Traffic compares known billing-cycle bytes,
// including servers without a quota; a missing measurement is never a zero.
export function monitorHighlights(nodes = []) {
  return [
    { key: 'cpu', label: 'CPU 占用最高', live: true },
    { key: 'memory', label: '内存占用最高', live: true },
    { key: 'trafficUsed', label: '本周期流量最多', live: false }
  ].map(metric => {
    const eligible = nodes.filter(node => (!metric.live || (node.online && node.fresh))
      && Number.isFinite(node[metric.key]) && node[metric.key] >= 0)
    const node = eligible.reduce((best, item) => !best || item[metric.key] > best[metric.key]
      || (item[metric.key] === best[metric.key] && item.id < best.id) ? item : best, null)
    return { ...metric, node, value: node?.[metric.key] ?? null }
  })
}
