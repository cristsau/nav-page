<script setup>
import { computed, ref, watch } from 'vue'
import { formatMetric, nearestSample, trendGeometry } from './trendGeometry'
const props = defineProps({ points: { type: Array, default: () => [] }, label: { type: String, default: '趋势' }, valueKey: { type: String, default: 'ms' }, gapSeconds: { type: Number, default: 180 }, unit: { type: String, default: 'ms' }, from: [String, Date], to: [String, Date], step: { type: Number, default: 0 } })
const chart = computed(() => trendGeometry(props.points, props)), cursor = ref(null)
const active = computed(() => cursor.value === null ? null : nearestSample(chart.value.data, cursor.value, props.gapSeconds * 500))
const format = v => formatMetric(v, props.unit)
const time = (t, full = false) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(full ? { second: '2-digit' } : {}), hour12: false })
const ticks = computed(() => [0, 1, 2].map(i => chart.value.lo + (chart.value.hi - chart.value.lo) * i / 2))
function move(event) {
  const box = event.currentTarget.getBoundingClientRect(), x = (event.clientX - box.left) / box.width * 400
  cursor.value = chart.value.lo + Math.min(1, Math.max(0, (x - 72) / 312)) * (chart.value.hi - chart.value.lo)
}
function key(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Escape') { cursor.value = null; return }
  const data = chart.value.data
  if (!data.length) return
  const index = active.value ? data.indexOf(active.value) : data.length - 1
  cursor.value = data[event.key === 'Home' ? 0 : event.key === 'End' ? data.length - 1 : Math.min(data.length - 1, Math.max(0, index + (event.key === 'ArrowLeft' ? -1 : 1)))].t
}
watch(() => [props.points, props.valueKey, props.from, props.to], () => { cursor.value = null })
</script>
<template>
  <div class="trend">
    <svg viewBox="0 0 400 163" role="img" tabindex="0" :aria-label="`${label}，左右方向键查看采样`" @pointermove="move" @pointerdown="move" @pointerleave="event => { if (event.pointerType === 'mouse') cursor = null }" @keydown="key" @blur="cursor = null">
      <g v-for="fraction in [0, .5, 1]" :key="fraction" class="axis"><line x1="72" x2="384" :y1="chart.y(chart.max * fraction)" :y2="chart.y(chart.max * fraction)"/><text x="67" :y="chart.y(chart.max * fraction) + 3" text-anchor="end">{{ format(chart.max * fraction) }}</text></g>
      <g v-for="(tick, i) in ticks" :key="i" class="axis"><text :x="chart.x(tick)" y="148" :text-anchor="i === 0 ? 'start' : i === 2 ? 'end' : 'middle'">{{ chart.data.length || from ? time(tick) : '' }}</text></g>
      <template v-for="(segment, i) in chart.segments" :key="i"><polyline :points="segment.map(p => `${p.x},${p.y}`).join(' ')"/><circle v-if="segment.length === 1" :cx="segment[0].x" :cy="segment[0].y" r="2"/></template>
      <text v-if="!chart.values.length" x="220" y="70" text-anchor="middle" class="empty">暂无有效采样</text>
      <g v-if="active"><line class="cursor" :x1="chart.x(active.t)" :x2="chart.x(active.t)" y1="14" y2="126"/><circle v-if="Number.isFinite(active.v)" :cx="chart.x(active.t)" :cy="chart.y(active.v)" r="3.5"/></g>
    </svg>
    <div class="readout" aria-live="polite"><template v-if="cursor !== null"><time>{{ time(active?.t ?? cursor, true) }}</time><strong>{{ active ? format(active.v) : '该时段无采样' }}</strong><small v-if="step > 60">{{ step / 60 }} 分钟汇总</small></template><template v-else><span>悬停或点按查看</span><span v-if="chart.values.length">{{ format(Math.min(...chart.values)) }} — {{ format(Math.max(...chart.values)) }}</span></template></div>
  </div>
</template>
<style scoped>
.trend{min-width:0;color:var(--accent-color)}svg{display:block;width:100%;overflow:visible;touch-action:pan-y;outline-offset:2px}polyline{fill:none;stroke:currentColor;stroke-width:1.5;vector-effect:non-scaling-stroke}circle{fill:currentColor}.axis line{stroke:var(--border-color);stroke-width:1;stroke-dasharray:3 3}.axis text,.empty{fill:var(--text-secondary);font-size:13px}.cursor{stroke:currentColor;stroke-width:1;stroke-dasharray:3 2}.readout{min-height:32px;display:flex;gap:6px;flex-wrap:wrap;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums}.readout strong{color:var(--text-primary)}
</style>
