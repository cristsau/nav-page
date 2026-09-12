import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMobileDock } from '../../app/src/shared/navigation/mobileDock.js'

const base = { layoutHeight: 844, visualHeight: 844, height: 64, gap: 34 }
test('dock uses its measured height, safe-area gap and one content reserve', () => {
  assert.deepEqual(resolveMobileDock(base), { top: 746, space: 110, keyboard: false })
  assert.deepEqual(resolveMobileDock({ ...base, height: 94 }), { top: 716, space: 140, keyboard: false })
})
test('stale visual keyboard height/offset after blur must not leave the dock in mid-screen', () => {
  assert.deepEqual(resolveMobileDock({ ...base, visualHeight: 520, visualTop: 80 }), resolveMobileDock(base))
})
test('keyboard hides navigation only for focused editable controls and restores on blur', () => {
  assert.equal(resolveMobileDock({ ...base, visualHeight: 520, editable: true }).keyboard, true)
  assert.equal(resolveMobileDock({ ...base, visualHeight: 800, editable: true }).keyboard, false)
  assert.equal(resolveMobileDock({ ...base, visualHeight: 520, editable: false }).keyboard, false)
})
test('rotation and browser-toolbar changes use the current CSS viewport, not a saved maximum', () => {
  assert.equal(resolveMobileDock({ ...base, layoutHeight: 390, visualHeight: 320 }).top, 292)
  assert.equal(resolveMobileDock({ ...base, layoutHeight: 740, visualHeight: 740 }).top, 642)
})
test('pinch zoom remains available and is not mistaken for a keyboard', () => {
  assert.deepEqual(resolveMobileDock({ ...base, visualHeight: 422, visualTop: 90, scale: 2, editable: true }),
    { top: 414, space: 110, keyboard: false })
})
test('unavailable viewport metrics fall back without NaN, negative offsets or exceptions', () => {
  assert.equal(resolveMobileDock({ ...base, visualHeight: undefined, visualTop: NaN, scale: undefined }).top, 746)
  assert.equal(resolveMobileDock({ layoutHeight: NaN, visualHeight: 600, height: 0, gap: -50 }).top, 536)
})
