export function formatMetric(value, unit = 'ms') {
  if (!Number.isFinite(value)) return '无有效采样'
  if (unit === 'B/s') {
    const i = Math.min(3, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024))))
    return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B/s', 'KiB/s', 'MiB/s', 'GiB/s'][i]}`
  }
  return `${value.toFixed(1)} ${unit}`
}
export function trendGeometry(points, { valueKey = 'ms', unit = 'ms', from, to, gapSeconds = 180 } = {}) {
  const data = points.map(p => ({ t: new Date(p.at).getTime(), v: p.addresses?.length > 1 ? null : p[valueKey], address: p.addresses?.join(',') || p.address || '' })).filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t)
  const start = from ? new Date(from).getTime() : data[0]?.t, end = to ? new Date(to).getTime() : data.at(-1)?.t
  const lo = Number.isFinite(start) ? start : 0, hi = Math.max(lo + 1, Number.isFinite(end) ? end : lo + 1)
  const visible = data.filter(p => p.t >= lo && p.t <= hi), values = visible.filter(p => Number.isFinite(p.v)).map(p => p.v)
  const peak = Math.max(1, ...values), magnitude = 10 ** Math.floor(Math.log10(peak))
  const max = unit === '%' ? Math.max(100, peak) : Math.ceil(peak / magnitude / 2) * magnitude * 2
  const x = t => 72 + (t - lo) / (hi - lo) * 312, y = v => 126 - Math.max(0, v) / max * 112
  const segments = []; let current = [], previous
  for (const p of visible) {
    if (!Number.isFinite(p.v) || (previous && (p.t - previous.t > gapSeconds * 1000 || p.address !== previous.address))) { if (current.length) segments.push(current); current = [] }
    if (Number.isFinite(p.v)) current.push({ ...p, x: x(p.t), y: y(p.v) })
    previous = p
  }
  if (current.length) segments.push(current)
  return { data: visible, lo, hi, max, x, y, segments, values }
}
export function nearestSample(data, timestamp, maxDistance) {
  let lo = 0, hi = data.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (data[mid].t < timestamp) lo = mid + 1; else hi = mid }
  const point = [data[lo - 1], data[lo]].filter(Boolean).sort((a, b) => Math.abs(a.t - timestamp) - Math.abs(b.t - timestamp))[0]
  return point && Math.abs(point.t - timestamp) <= maxDistance ? point : null
}
