import type { ITheme } from '@xterm/xterm'

export type ThemeMode = 'light' | 'dark'

/** Interface colours. Each key becomes the CSS variable `--color-<key>` that the Tailwind classes read. */
export interface UiColors {
  bg: string
  panel: string
  sidebar: string
  raised: string
  line: string
  ink: string
  dim: string
  faint: string
  accent: string
  /** Text and icons drawn on top of the accent colour. */
  onAccent: string
  good: string
  warn: string
  bad: string
  /** The frame around a pane in full screen. */
  zoom: string
}

export interface ThemeDef {
  id: string
  name: string
  mode: ThemeMode
  ui: UiColors
  terminal: ITheme
}

type Ansi = [string, string, string, string, string, string, string, string]

/** Builds a terminal palette from the eight normal and eight bright colours, in ANSI order. */
function terminal(
  base: { background: string; foreground: string; selection: string },
  normal: Ansi,
  bright: Ansi,
): ITheme {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] =
    bright
  return {
    background: base.background,
    foreground: base.foreground,
    cursor: base.foreground,
    cursorAccent: base.background,
    selectionBackground: base.selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  }
}

// To add a theme, append an entry here. The picker, the command palette and
// the first-paint script all read this list.
export const THEMES: ThemeDef[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    mode: 'dark',
    ui: {
      bg: '#0c0d10',
      panel: '#111317',
      sidebar: '#16181d',
      raised: '#1c1f26',
      line: '#262a33',
      ink: '#e7e9ee',
      dim: '#9197a6',
      faint: '#636978',
      accent: '#3b82f6',
      onAccent: '#ffffff',
      good: '#3fb950',
      warn: '#d29922',
      bad: '#f85149',
      zoom: '#a371f7',
    },
    terminal: terminal(
      { background: '#111317', foreground: '#dfe2e9', selection: '#3b82f655' },
      ['#1c1f26', '#f47067', '#57ab5a', '#c69026', '#539bf5', '#b083f0', '#39c5cf', '#909dab'],
      ['#636e7b', '#ff938a', '#6bc46d', '#daaa3f', '#6cb6ff', '#dcbdfb', '#56d4dd', '#cdd9e5'],
    ),
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    ui: {
      bg: '#1e1f29',
      panel: '#282a36',
      sidebar: '#21222c',
      raised: '#343746',
      line: '#44475a',
      ink: '#f8f8f2',
      dim: '#b4b8cc',
      faint: '#7582b3',
      accent: '#bd93f9',
      onAccent: '#21222c',
      good: '#50fa7b',
      warn: '#ffb86c',
      bad: '#ff5555',
      zoom: '#ff79c6',
    },
    terminal: terminal(
      { background: '#282a36', foreground: '#f8f8f2', selection: '#44475aaa' },
      ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
      ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
    ),
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    ui: {
      bg: '#272c36',
      panel: '#2e3440',
      sidebar: '#2b303b',
      raised: '#3b4252',
      line: '#434c5e',
      ink: '#eceff4',
      dim: '#b5bfcf',
      faint: '#7b88a1',
      accent: '#88c0d0',
      onAccent: '#2e3440',
      good: '#a3be8c',
      warn: '#ebcb8b',
      bad: '#bf616a',
      zoom: '#b48ead',
    },
    terminal: terminal(
      { background: '#2e3440', foreground: '#d8dee9', selection: '#434c5ecc' },
      ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
      ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
    ),
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    ui: {
      bg: '#16161e',
      panel: '#1a1b26',
      sidebar: '#1f2335',
      raised: '#292e42',
      line: '#343a55',
      ink: '#c0caf5',
      dim: '#a9b1d6',
      faint: '#565f89',
      accent: '#7aa2f7',
      onAccent: '#16161e',
      good: '#9ece6a',
      warn: '#e0af68',
      bad: '#f7768e',
      zoom: '#bb9af7',
    },
    terminal: terminal(
      { background: '#1a1b26', foreground: '#c0caf5', selection: '#33467c' },
      ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
      ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
    ),
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    mode: 'dark',
    ui: {
      bg: '#1d2021',
      panel: '#282828',
      sidebar: '#32302f',
      raised: '#3c3836',
      line: '#504945',
      ink: '#ebdbb2',
      dim: '#bdae93',
      faint: '#928374',
      accent: '#fe8019',
      onAccent: '#1d2021',
      good: '#b8bb26',
      warn: '#fabd2f',
      bad: '#fb4934',
      zoom: '#d3869b',
    },
    terminal: terminal(
      { background: '#282828', foreground: '#ebdbb2', selection: '#504945cc' },
      ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
      ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
    ),
  },
  {
    id: 'daylight',
    name: 'Daylight',
    mode: 'light',
    ui: {
      bg: '#eef0f3',
      panel: '#ffffff',
      sidebar: '#f6f7f9',
      raised: '#e9ecf0',
      line: '#d5d9e0',
      ink: '#1b1f27',
      dim: '#586070',
      faint: '#8a909d',
      accent: '#2563eb',
      onAccent: '#ffffff',
      good: '#1a7f37',
      warn: '#9a6700',
      bad: '#cf222e',
      zoom: '#8250df',
    },
    terminal: terminal(
      { background: '#ffffff', foreground: '#24292f', selection: '#2563eb33' },
      ['#24292f', '#cf222e', '#116329', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
      ['#57606a', '#a40e26', '#1a7f37', '#7d4e00', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
    ),
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    ui: {
      bg: '#eee8d5',
      panel: '#fdf6e3',
      sidebar: '#f5efdc',
      raised: '#e8e1cb',
      line: '#d9d2ba',
      ink: '#073642',
      dim: '#586e75',
      faint: '#93a1a1',
      accent: '#268bd2',
      onAccent: '#fdf6e3',
      good: '#859900',
      warn: '#b58900',
      bad: '#dc322f',
      zoom: '#6c71c4',
    },
    terminal: terminal(
      { background: '#fdf6e3', foreground: '#657b83', selection: '#eee8d5' },
      ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
      ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
    ),
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    ui: {
      bg: '#dce0e8',
      panel: '#eff1f5',
      sidebar: '#e6e9ef',
      raised: '#d6dae3',
      line: '#bcc0cc',
      ink: '#4c4f69',
      dim: '#6c6f85',
      faint: '#8c8fa1',
      accent: '#1e66f5',
      onAccent: '#ffffff',
      good: '#40a02b',
      warn: '#df8e1d',
      bad: '#d20f39',
      zoom: '#8839ef',
    },
    terminal: terminal(
      { background: '#eff1f5', foreground: '#4c4f69', selection: '#acb0be88' },
      ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be'],
      ['#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'],
    ),
  },
]

export const DEFAULT_THEME: Record<ThemeMode, string> = { dark: 'midnight', light: 'daylight' }

/** localStorage keys: the mode choice, and the preferred theme for each mode. */
export const MODE_KEY = 'poc-theme'
export const themeKey = (mode: ThemeMode) => `poc-theme-${mode}`

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]))

export function themeById(id: string | null | undefined): ThemeDef | undefined {
  return id ? BY_ID.get(id) : undefined
}

/** The theme to use for a mode: the saved one if it exists and fits the mode, else the default. */
export function themeFor(mode: ThemeMode, preferredId: string | null | undefined): ThemeDef {
  const preferred = themeById(preferredId)
  return preferred?.mode === mode ? preferred : (BY_ID.get(DEFAULT_THEME[mode]) as ThemeDef)
}

function cssVariables(ui: UiColors): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ui).map(([key, value]) => [
      `--color-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      value,
    ]),
  )
}

export function applyThemeToDocument(theme: ThemeDef) {
  const root = document.documentElement
  root.dataset.theme = theme.mode
  for (const [name, value] of Object.entries(cssVariables(theme.ui))) root.style.setProperty(name, value)
}

/**
 * Inline script for the document head. It applies the saved theme before the
 * first paint, so the page never flashes the default colours.
 */
export const THEME_BOOT_SCRIPT = (() => {
  const table = Object.fromEntries(THEMES.map((t) => [t.id, { m: t.mode, v: cssVariables(t.ui) }]))
  return `(function(){try{var T=${JSON.stringify(table)},D=${JSON.stringify(DEFAULT_THEME)},L=localStorage,c=L.getItem('${MODE_KEY}'),m=c==='light'||c==='dark'?c:(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'),t=T[L.getItem('poc-theme-'+m)];if(!t||t.m!==m)t=T[D[m]];var r=document.documentElement;r.dataset.theme=m;for(var k in t.v)r.style.setProperty(k,t.v[k])}catch(e){}})()`
})()
