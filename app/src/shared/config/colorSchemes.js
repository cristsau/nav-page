export const MUTED_TEXT_MIN_CONTRAST = 4.5
export const MUTED_TEXT_DESIGN_CONTRAST = 4.8
export const DARK_RAISED_SURFACE_WHITE_MIX = 0.04

export const colorSchemes = {
  cream: {
    name: '奶油',
    primary: '#a08060',
    bg: '#faf8f5',
    bgSecondary: '#f5f2ed',
    bgCard: '#ffffff',
    textPrimary: '#4a4540',
    textSecondary: '#7a756d',
    darkBg: '#1e1815',
    darkBgSecondary: '#2a211d',
    darkBgCard: '#372b25',
    darkTextPrimary: '#f1e8df',
    darkTextSecondary: '#c7b7a7'
  },
  ocean: {
    name: '海洋',
    primary: '#5a8fa8',
    bg: '#f0f5f8',
    bgSecondary: '#e5eef3',
    bgCard: '#ffffff',
    textPrimary: '#3a5060',
    textSecondary: '#6a8090',
    darkBg: '#0f1820',
    darkBgSecondary: '#152734',
    darkBgCard: '#1e3648',
    darkTextPrimary: '#e3f1f7',
    darkTextSecondary: '#9fc2d4'
  },
  forest: {
    name: '森林',
    primary: '#5a8a6a',
    bg: '#f5f8f5',
    bgSecondary: '#e8f0e8',
    bgCard: '#ffffff',
    textPrimary: '#3a5040',
    textSecondary: '#6a8070',
    darkBg: '#121915',
    darkBgSecondary: '#1a2a20',
    darkBgCard: '#24382b',
    darkTextPrimary: '#e6f2e8',
    darkTextSecondary: '#a9c7b0'
  },
  rose: {
    name: '玫瑰',
    primary: '#c48a9a',
    bg: '#faf5f8',
    bgSecondary: '#f5e8ee',
    bgCard: '#ffffff',
    textPrimary: '#5a4050',
    textSecondary: '#8a7080',
    darkBg: '#2a151f',
    darkBgSecondary: '#462432',
    darkBgCard: '#603142',
    darkTextPrimary: '#f7e5ec',
    darkTextSecondary: '#ddb2c0'
  },
  lavender: {
    name: '薰衣草',
    primary: '#8a8ac4',
    bg: '#f5f5fa',
    bgSecondary: '#eaeaf5',
    bgCard: '#ffffff',
    textPrimary: '#404060',
    textSecondary: '#707090',
    darkBg: '#171623',
    darkBgSecondary: '#26233a',
    darkBgCard: '#383454',
    darkTextPrimary: '#ecebfb',
    darkTextSecondary: '#bbb8e3'
  },
  sunset: {
    name: '日落',
    primary: '#c48a6a',
    bg: '#faf8f5',
    bgSecondary: '#f5ece5',
    bgCard: '#ffffff',
    textPrimary: '#5a4a40',
    textSecondary: '#8a7060',
    darkBg: '#261712',
    darkBgSecondary: '#3d241c',
    darkBgCard: '#573329',
    darkTextPrimary: '#f7e9e1',
    darkTextSecondary: '#ddb49d'
  },
  custom: {
    name: '自定义'
  }
}

function parseHex(hex) {
  const value = String(hex || '').trim().replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return null
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16))
}

export function mixHex(colorA, colorB, weight) {
  const first = parseHex(colorA)
  const second = parseHex(colorB)
  if (!first || !second) return colorA

  const ratio = Math.min(1, Math.max(0, weight))
  return `#${first.map((channel, index) => (
    Math.round(channel + ((second[index] - channel) * ratio))
      .toString(16)
      .padStart(2, '0')
  )).join('')}`
}

function relativeLuminance(hex) {
  const channels = parseHex(hex)
  if (!channels) return 0

  return channels
    .map((channel) => {
      const value = channel / 255
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4
    })
    .reduce((total, value, index) => total + (value * [0.2126, 0.7152, 0.0722][index]), 0)
}

export function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function minimumContrast(color, surfaces) {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)))
}

/**
 * Produce a visually subdued helper color without sacrificing small-text
 * readability. The result is checked against every surface where helper text
 * is used: page background, card and secondary/input surface.
 */
export function resolveAccessibleMutedColor(preferred, surfaces, darkSurface = false) {
  const validSurfaces = surfaces.filter((surface) => parseHex(surface))
  if (!parseHex(preferred) || !validSurfaces.length) {
    return darkSurface ? '#ffffff' : '#000000'
  }

  const contrastTarget = darkSurface ? '#ffffff' : '#000000'
  let accessible = preferred

  if (minimumContrast(accessible, validSurfaces) < MUTED_TEXT_DESIGN_CONTRAST) {
    for (let step = 1; step <= 100; step += 1) {
      const candidate = mixHex(preferred, contrastTarget, step / 100)
      if (minimumContrast(candidate, validSurfaces) >= MUTED_TEXT_DESIGN_CONTRAST) {
        accessible = candidate
        break
      }
    }
  }

  const nearestSurface = validSurfaces.reduce((nearest, surface) => (
    contrastRatio(accessible, surface) < contrastRatio(accessible, nearest)
      ? surface
      : nearest
  ), validSurfaces[0])

  let muted = accessible
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mixHex(accessible, nearestSurface, step / 100)
    if (minimumContrast(candidate, validSurfaces) < MUTED_TEXT_DESIGN_CONTRAST) break
    muted = candidate
  }

  return muted
}

export function resolveThemeMutedColors(scheme) {
  const raisedDarkCard = mixHex(
    scheme.darkBgCard,
    '#ffffff',
    DARK_RAISED_SURFACE_WHITE_MIX
  )

  return {
    light: resolveAccessibleMutedColor(
      scheme.textSecondary,
      [scheme.bg, scheme.bgCard, scheme.bgSecondary],
      false
    ),
    dark: resolveAccessibleMutedColor(
      scheme.darkTextSecondary,
      [scheme.darkBg, scheme.darkBgCard, raisedDarkCard, scheme.darkBgSecondary],
      true
    )
  }
}
