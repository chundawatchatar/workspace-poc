// Plain data, free of the store and React, so the marketing site can list the same shortcuts.

export const LEADER_LABEL = 'Ctrl+B'

export interface ShortcutRow {
  label: string
  leader?: string
  direct?: string
}

export const SHORTCUT_ROWS: ShortcutRow[] = [
  { label: 'Command palette', direct: '⌘P on Mac  ·  Ctrl+Shift+P' },
  { label: 'Split right', leader: 'D', direct: 'Ctrl+Shift+D  ·  ⌘D on Mac' },
  { label: 'Split down', leader: 'E', direct: 'Ctrl+Shift+E  ·  ⌘⇧D on Mac' },
  { label: 'New terminal tab', leader: 'C', direct: 'Ctrl+Shift+Enter' },
  { label: 'Close tab', leader: 'X', direct: 'Ctrl+Shift+X' },
  { label: 'Next / previous tab', leader: 'N / P', direct: 'Ctrl+Shift+] / [' },
  { label: 'Focus pane in a direction', leader: '← ↑ ↓ →', direct: 'Ctrl+Shift+Arrow' },
  { label: 'Focus next pane', leader: 'O' },
  { label: 'Full screen pane', leader: 'Z', direct: 'Ctrl+Shift+F' },
  { label: 'Go to workspace 1–9', leader: '1 – 9', direct: 'Ctrl+Shift+1 – 9' },
  { label: 'New workspace', leader: 'W' },
  { label: 'Toggle sidebar', leader: 'B', direct: '⌘B on Mac' },
  { label: 'Choose theme', leader: 'T' },
  { label: 'Show shortcuts', leader: '?' },
  { label: 'Send Ctrl+B to the terminal', leader: 'Ctrl+B' },
  { label: 'Clear terminal', direct: '⌘K on Mac' },
  { label: 'New line in Claude, Codex…', direct: 'Shift+Enter' },
]
