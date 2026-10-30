// Reorder only visible slots, so filtering never moves or drops hidden servers.
export function mergeVisibleOrder(all, visible, reordered) {
  const set = new Set(visible)
  if (new Set(all).size !== all.length || set.size !== visible.length
    || reordered.length !== visible.length || new Set(reordered).size !== set.size
    || visible.some(id => !all.includes(id)) || reordered.some(id => !set.has(id))) throw Error('服务器列表已变化，请刷新后再排序。')
  let index = 0
  return all.map(id => set.has(id) ? reordered[index++] : id)
}

