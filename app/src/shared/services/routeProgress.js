const ROUTE_PROGRESS_DELAY_MS = 100
const ROUTE_PROGRESS_REMOVE_MS = 180
const ROUTE_PROGRESS_ID = 'domo-route-progress'

let showTimer = null
let removeTimer = null
let activeNavigations = 0

function getProgressElement() {
  return typeof document === 'undefined'
    ? null
    : document.getElementById(ROUTE_PROGRESS_ID)
}

function createProgressElement() {
  const existing = getProgressElement()
  if (existing) return existing

  const element = document.createElement('div')
  element.id = ROUTE_PROGRESS_ID
  element.className = 'route-progress'
  element.setAttribute('role', 'progressbar')
  element.setAttribute('aria-label', '页面加载中')
  element.setAttribute('aria-valuemin', '0')
  element.setAttribute('aria-valuemax', '100')
  element.setAttribute('aria-valuetext', '正在加载')
  document.body.append(element)
  window.requestAnimationFrame(() => {
    element.classList.add('route-progress--visible')
  })
  return element
}

export function startRouteProgress() {
  if (typeof document === 'undefined') return

  activeNavigations += 1
  if (activeNavigations > 1) return

  window.clearTimeout(showTimer)
  window.clearTimeout(removeTimer)
  getProgressElement()?.remove()

  showTimer = window.setTimeout(() => {
    if (activeNavigations < 1) return
    createProgressElement()
  }, ROUTE_PROGRESS_DELAY_MS)
}

export function finishRouteProgress() {
  if (typeof document === 'undefined') return

  activeNavigations = Math.max(0, activeNavigations - 1)
  if (activeNavigations > 0) return

  window.clearTimeout(showTimer)
  showTimer = null

  const element = getProgressElement()
  if (!element) return

  element.classList.add('route-progress--complete')
  removeTimer = window.setTimeout(() => {
    element.remove()
  }, ROUTE_PROGRESS_REMOVE_MS)
}

export { ROUTE_PROGRESS_DELAY_MS }
