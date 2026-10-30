// Present existing server alerts; this does not create or change alert thresholds.
export function monitorAlerts(alerts = [], nodes = []) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const percent = value => `${value.toFixed(1)}%`
  return alerts.map((alert, index) => {
    const node = byId.get(alert.nodeId), name = node?.name || `服务器 #${alert.nodeId}`
    let reason = alert.text?.startsWith(name + ' ') ? alert.text.slice(name.length + 1) : alert.text || '状态需要检查'
    if (alert.kind === 'expiry' && Number.isFinite(node?.expiryDays)) {
      const days = node.expiryDays
      reason = days < 0 ? `已过期 ${Math.abs(days)} 天` : days === 0 ? '今天到期' : `${days} 天后到期`
    } else if (alert.kind === 'traffic' && Number.isFinite(node?.trafficPercent)) {
      reason = `流量已用 ${percent(node.trafficPercent)}`
    } else if (alert.kind === 'capacity' && node?.fresh) {
      const values = [['内存', node.memory], ['磁盘', node.disk]]
        .filter(([, value]) => Number.isFinite(value) && value >= 85)
      if (values.length) reason = values.map(([label, value]) => `${label} ${percent(value)}`).join(' · ')
    }
    const critical = alert.kind === 'offline' || (alert.kind === 'expiry' && node?.expiryDays < 0)
    const priority = critical ? 0 : { capacity: 1, traffic: 2, expiry: 3 }[alert.kind] ?? 4
    return { ...alert, name, reason, priority, tone: critical ? 'critical' : 'attention', key: `${alert.nodeId}-${alert.kind}-${index}` }
  }).sort((a, b) => a.priority - b.priority)
}
