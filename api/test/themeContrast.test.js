import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  colorSchemes,
  contrastRatio,
  DARK_RAISED_SURFACE_WHITE_MIX,
  mixHex,
  MUTED_TEXT_DESIGN_CONTRAST,
  MUTED_TEXT_MIN_CONTRAST,
  resolveThemeMutedColors
} from '../../app/src/shared/config/colorSchemes.js'

const builtInThemes = Object.entries(colorSchemes)
  .filter(([themeId]) => themeId !== 'custom')

test('all built-in helper text colors meet WCAG AA on page, card and input surfaces', () => {
  assert.equal(builtInThemes.length, 6)

  for (const [themeId, scheme] of builtInThemes) {
    const muted = resolveThemeMutedColors(scheme)
    const modes = [
      {
        id: 'light',
        color: muted.light,
        surfaces: {
          page: scheme.bg,
          card: scheme.bgCard,
          input: scheme.bgSecondary
        }
      },
      {
        id: 'dark',
        color: muted.dark,
        surfaces: {
          page: scheme.darkBg,
          card: scheme.darkBgCard,
          raisedCard: mixHex(scheme.darkBgCard, '#ffffff', DARK_RAISED_SURFACE_WHITE_MIX),
          input: scheme.darkBgSecondary
        }
      }
    ]

    for (const mode of modes) {
      for (const [surfaceId, surface] of Object.entries(mode.surfaces)) {
        const ratio = contrastRatio(mode.color, surface)
        assert.ok(
          ratio >= MUTED_TEXT_DESIGN_CONTRAST,
          `${themeId}/${mode.id}/${surfaceId} has only ${ratio.toFixed(2)}:1 contrast`
        )
        assert.ok(ratio >= MUTED_TEXT_MIN_CONTRAST)
      }
    }
  }
})

test('static cream theme helper tokens match the runtime resolver', async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL('../../app/src/styles/variables.css', import.meta.url)),
    'utf8'
  )
  const lightSource = source.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const darkSource = source.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const readMutedToken = (css) => css.match(/--text-muted:\s*(#[0-9a-f]{6})/i)?.[1]?.toLowerCase()
  const resolved = resolveThemeMutedColors(colorSchemes.cream)

  assert.equal(readMutedToken(lightSource), resolved.light)
  assert.equal(readMutedToken(darkSource), resolved.dark)
})

test('dark helper text accounts for the raised card surface used by live CSS', async () => {
  const [bookmarkCard, commandPalette] = await Promise.all([
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/navigation/components/NavItem.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/shared/components/CommandPalette.vue', import.meta.url)),
      'utf8'
    )
  ])

  assert.match(bookmarkCard, /var\(--bg-card\) 96%, white 4%/)
  assert.match(commandPalette, /var\(--bg-card\) 96%, white/)
  assert.equal(DARK_RAISED_SURFACE_WHITE_MIX, 0.04)
})
test('runtime theme application keeps the accessible helper color authoritative', async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL('../../app/src/shared/composables/useConfig.js', import.meta.url)),
    'utf8'
  )

  assert.match(source, /const mutedColors = resolveThemeMutedColors\(scheme\)/)
  assert.match(source, /setProperty\('--text-muted', mutedColors\.dark, 'important'\)/)
  assert.match(source, /setProperty\('--text-muted', mutedColors\.light, 'important'\)/)
  assert.doesNotMatch(source, /mixColors\(scheme\.darkTextSecondary, scheme\.darkBg, 0\.72\)/)
  assert.doesNotMatch(source, /adjustColor\(scheme\.textSecondary, 40\)/)
})
