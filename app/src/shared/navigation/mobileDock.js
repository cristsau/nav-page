// The CSS dynamic viewport is authoritative after the keyboard closes. WebKit
// can keep an old visualViewport height/offset after credential/password sheets.
// Do not compensate by scrolling the document or disabling user zoom.
export function resolveMobileDock({ layoutHeight, visualHeight, visualTop = 0, scale = 1, editable = false, height = 64, gap = 10 }) {
  const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback
  const viewportHeight = positive(layoutHeight, positive(visualHeight, 1))
  const visibleHeight = positive(visualHeight, viewportHeight)
  const dockHeight = positive(height, 64)
  const bottomGap = Number.isFinite(gap) ? Math.max(0, gap) : 10
  const zoomed = Number.isFinite(scale) && Math.abs(scale - 1) > 0.02
  const keyboard = Boolean(editable && !zoomed && viewportHeight - visibleHeight > 120)
  const top = zoomed && Number.isFinite(visualTop) ? Math.max(0, visualTop) : 0
  return {
    top: Math.max(0, top + (zoomed ? visibleHeight : viewportHeight) - dockHeight - bottomGap),
    space: Math.ceil(dockHeight + bottomGap + 12),
    keyboard
  }
}
