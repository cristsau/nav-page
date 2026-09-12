// Only in-memory predicates and generic messages; never persist form contents.
const guards = new Set()

export function registerReloadGuard(guard) {
  guards.add(guard)
  return () => guards.delete(guard)
}

export function assertSafeToReload() {
  for (const guard of guards) {
    const reason = guard()
    if (reason) throw new Error(String(reason))
  }
  // Other modal editors must be closed deliberately before a version refresh.
  const dialogs = globalThis.document?.querySelectorAll('[role="dialog"][aria-modal="true"]') || []
  if ([...dialogs].some((dialog) => dialog.getClientRects().length && !dialog.hidden)) {
    throw new Error('请先保存并关闭当前编辑窗口，再应用更新。')
  }
}

export function confirmVersionReload(confirm = (message) => globalThis.window.confirm(message)) {
  assertSafeToReload()
  const accepted = confirm('应用更新将刷新当前页面。请确认表单已保存、离线修改已同步。更新不会主动清除登录、书签或本机数据。现在更新吗？')
  if (accepted) assertSafeToReload()
  return accepted
}
