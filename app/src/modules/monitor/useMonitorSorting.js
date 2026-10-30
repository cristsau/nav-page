import { nextTick, onBeforeUnmount, ref } from 'vue'
import { apiRequest } from '@/shared/services/apiClient'

import { mergeVisibleOrder } from './monitorOrder'

export function useMonitorSorting({ allNodes, visibleNodes, applyOrder, pauseRefresh, resumeRefresh }) {
  const dragId = ref(null), overId = ref(null), dropSide = ref('before'), pointer = ref({ x: 0, y: 0 })
  const saving = ref(false), message = ref(''), failed = ref(false)
  let gesture, frame, disposed = false
  const same = (a, b) => a.length === b.length && a.every((id, index) => id === b[index])
  const serverOrder = async () => (await apiRequest('/monitor/admin/nodes', { cache: 'no-store' })).nodes.map(n => n.id)

  async function save(visible, reordered, baseline) {
    let ids
    try { ids = mergeVisibleOrder(baseline, visible, reordered) } catch (error) { failed.value = true; message.value = error.message; return }
    if (same(ids, baseline)) return
    saving.value = true; failed.value = false; message.value = '正在保存顺序…'; pauseRefresh()
    let attempted = false
    try {
      const current = await serverOrder()
      if (disposed) return
      if (!same(current, baseline)) {
        applyOrder(current); throw Error('服务器顺序已变化，已显示当前顺序，请重新拖动。')
      }
      applyOrder(ids)
      attempted = true
      await apiRequest('/monitor/admin/nodes/order', { method: 'PUT', body: JSON.stringify({ ids }) })
      const actual = await serverOrder()
      if (disposed) return
      if (!same(actual, ids)) { applyOrder(actual); throw Error('服务器顺序已变化，已显示当前顺序，请重新拖动。') }
      message.value = '顺序已保存'
    } catch (error) {
      if (disposed) return
      if (attempted) {
        // A lost response may still represent a completed write. Read back once;
        // never repeat the write or announce success without matching evidence.
        try {
          const actual = await serverOrder(); if (disposed) return; applyOrder(actual)
          if (same(actual, ids)) { message.value = '顺序已保存'; return }
          message.value = same(actual, baseline) ? '排序未保存，已恢复原顺序。请重试。' : '顺序已被更新，已显示服务器当前顺序。'
        } catch { applyOrder(baseline); message.value = '暂时无法确认排序结果，请刷新核对后再操作。' }
      } else message.value = error.message || '无法读取当前顺序，请刷新后再试。'
      failed.value = true
    } finally { saving.value = false; if (!disposed) resumeRefresh() }
  }

  function findTarget() {
    const row = document.elementFromPoint(pointer.value.x, pointer.value.y)?.closest('.node-row[data-node-id]')
    const id = row ? Number(row.dataset.nodeId) : null
    overId.value = id !== dragId.value && gesture?.visible.includes(id) ? id : null
    if (overId.value !== null) dropSide.value = pointer.value.y < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? 'before' : 'after'
  }
  function scroll() {
    if (dragId.value === null) return
    const edge = 80, y = pointer.value.y
    const delta = y < edge ? -Math.min(12, (edge - y) / 5) : y > innerHeight - edge ? Math.min(12, (y - innerHeight + edge) / 5) : 0
    if (delta) { window.scrollBy(0, delta); findTarget() }
    frame = requestAnimationFrame(scroll)
  }
  function clear() {
    const current = gesture; gesture = null
    cancelAnimationFrame(frame); dragId.value = null; overId.value = null
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    document.removeEventListener('keydown', escape)
    if (!disposed) resumeRefresh()
  }
  function escape(event) { if (event.key === 'Escape') { event.preventDefault(); clear(); message.value = '已取消排序' } }
  function start(event, id) {
    if (saving.value || event.button !== 0 || visibleNodes().length < 2) return
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true })
    const element = event.currentTarget
    gesture = { id, element, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      visible: visibleNodes().map(n => n.id), baseline: allNodes().map(n => n.id) }
    element.setPointerCapture(event.pointerId)
    pointer.value = { x: event.clientX, y: event.clientY }; pauseRefresh()
    document.addEventListener('keydown', escape)
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    pointer.value = { x: event.clientX, y: event.clientY }
    if (dragId.value === null && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) {
      dragId.value = gesture.id; message.value = '拖到目标位置后松开'; failed.value = false; scroll()
    }
    if (dragId.value !== null) { event.preventDefault(); findTarget() }
  }
  function end(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const current = gesture, target = overId.value, side = dropSide.value, dragged = dragId.value
    clear()
    if (dragged === null || target === null) return
    const reordered = current.visible.filter(id => id !== dragged)
    reordered.splice(reordered.indexOf(target) + (side === 'after' ? 1 : 0), 0, dragged)
    void save(current.visible, reordered, current.baseline)
  }
  async function key(event, id) {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || saving.value || gesture) return
    event.preventDefault()
    const visible = visibleNodes().map(n => n.id), index = visible.indexOf(id), target = index + (event.key === 'ArrowUp' ? -1 : 1)
    if (target < 0 || target >= visible.length) return
    const reordered = [...visible]; [reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    const handle = event.currentTarget
    await save(visible, reordered, allNodes().map(n => n.id))
    await nextTick()
    if (!disposed && handle.isConnected) handle.focus({ preventScroll: true })
  }
  onBeforeUnmount(() => { disposed = true; clear() })
  return { dragId, overId, dropSide, pointer, saving, message, failed, start, move, end, cancel: clear, key, active: () => Boolean(gesture) || saving.value }
}
