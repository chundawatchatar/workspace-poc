import { afterEach, describe, expect, test } from 'bun:test'
import { applyThemeToDocument, DEFAULT_THEME, themeById, themeFor } from './themes'

describe('themes', () => {
  test('themeFor keeps a saved theme that fits the mode, and falls back to the default otherwise', () => {
    expect(themeFor('light', 'solarized-light').id).toBe('solarized-light')
    // A dark theme saved for light, an unknown id, and nothing saved.
    expect(themeFor('light', 'nord').id).toBe(DEFAULT_THEME.light)
    expect(themeFor('dark', 'no-such-theme').id).toBe(DEFAULT_THEME.dark)
    expect(themeFor('dark', null).id).toBe(DEFAULT_THEME.dark)
    expect(themeById(undefined)).toBeUndefined()
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
    })
  })
})
