import { afterEach, describe, expect, test } from 'bun:test'
import { applyThemeToDocument, DEFAULT_THEME, THEMES, themeById, themeFor } from './themes'

function channels(hex: string) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
}

function hue(hex: string) {
  const [r, g, b] = channels(hex)
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (span === 0) return 0
  const sixths = max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  return (sixths * 60 + 360) % 360
}

function hueDistance(a: string, b: string) {
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}

/** WCAG 2 contrast ratio. */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = channels(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('themes', () => {
  test('themeFor keeps a saved theme that fits the mode, and falls back to the default otherwise', () => {
    expect(themeFor('light', 'solarized-light').id).toBe('solarized-light')
    // A dark theme saved for light, an unknown id, and nothing saved.
    expect(themeFor('light', 'nord').id).toBe(DEFAULT_THEME.light)
    expect(themeFor('dark', 'no-such-theme').id).toBe(DEFAULT_THEME.dark)
    expect(themeFor('dark', null).id).toBe(DEFAULT_THEME.dark)
    expect(themeById(undefined)).toBeUndefined()
  })

  // The working mark is orange in every theme, never mistaken for the waiting
  // colours (`warn`, and `accent` in the counts) or for `bad`, and readable on
  // the sidebar and the tab bar.
  test.each(THEMES.map((theme) => [theme.id, theme.ui] as const))('%s has a distinct orange busy colour', (_, ui) => {
    expect(ui.busy).toMatch(/^#[0-9a-f]{6}$/i)
    expect(hue(ui.busy)).toBeGreaterThanOrEqual(10)
    expect(hue(ui.busy)).toBeLessThanOrEqual(35)
    expect(hueDistance(ui.busy, ui.warn)).toBeGreaterThanOrEqual(8)
    expect(hueDistance(ui.busy, ui.accent)).toBeGreaterThanOrEqual(8)
    expect(hueDistance(ui.busy, ui.bad)).toBeGreaterThanOrEqual(10)
    expect(contrast(ui.busy, ui.sidebar)).toBeGreaterThanOrEqual(3)
    expect(contrast(ui.busy, ui.panel)).toBeGreaterThanOrEqual(3)
  })

  describe('applyThemeToDocument', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('data-theme')
      document.documentElement.removeAttribute('style')
    })

    test('sets the mode and the theme colours as CSS variables on the root element', () => {
      const theme = themeFor('light', 'daylight')
      applyThemeToDocument(theme)
      const root = document.documentElement
      expect(root.dataset.theme).toBe('light')
      expect(root.style.getPropertyValue('--color-accent')).toBe(theme.ui.accent)
      expect(root.style.getPropertyValue('--color-busy')).toBe(theme.ui.busy)
    })
  })
})
