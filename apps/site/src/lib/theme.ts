import { applyThemeToDocument, MODE_KEY, type ThemeChoice, type ThemeMode, themeFor, themeKey } from '@orch/ui/themes'

// The same choice and per-mode theme the app keeps, under the same keys. THEME_BOOT_SCRIPT applies them before paint.

export interface ThemeState {
  choice: ThemeChoice
  mode: ThemeMode
  themeId: string
  preferred: Record<ThemeMode, string>
}

// Choices made on this page, read before storage. Storage only carries them to the next page, and may refuse to.
const chosen = new Map<string, string>()

function read(key: string) {
  const value = chosen.get(key)
  if (value !== undefined) return value
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  chosen.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows can refuse storage; the choice still holds on this page.
  }
}

const systemMode = (): ThemeMode => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

export function readTheme(): ThemeState {
  const saved = read(MODE_KEY)
  const choice: ThemeChoice = saved === 'light' || saved === 'dark' ? saved : 'system'
  const mode = choice === 'system' ? systemMode() : choice
  const preferred = {
    dark: themeFor('dark', read(themeKey('dark'))).id,
    light: themeFor('light', read(themeKey('light'))).id,
  }
  return { choice, mode, themeId: preferred[mode], preferred }
}

/** Applies the saved theme with the app's cross-fade, and tells every island it changed. */
function apply() {
  const state = readTheme()
  const root = document.documentElement
  root.classList.add('theme-switching')
  applyThemeToDocument(themeFor(state.mode, state.themeId))
  window.setTimeout(() => root.classList.remove('theme-switching'), 260)
  window.dispatchEvent(new CustomEvent('orch:theme', { detail: state }))
}

export function chooseMode(choice: ThemeChoice) {
  write(MODE_KEY, choice)
  apply()
}

export function selectTheme(themeId: string, mode: ThemeMode) {
  write(themeKey(mode), themeId)
  write(MODE_KEY, mode)
  apply()
}

export function toggleMode() {
  chooseMode(readTheme().mode === 'dark' ? 'light' : 'dark')
}

/** Follows the system while the choice is "System". */
export function watchSystemTheme() {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (readTheme().choice === 'system') apply()
  })
}
