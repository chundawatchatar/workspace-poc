import { Check, Monitor, Moon, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { selectTheme, setThemeChoice, type ThemeChoice, useApp } from '../lib/store'
import { THEMES, type ThemeDef, type ThemeMode } from '../lib/themes'
import { Modal } from './Modal'

const MODES: { choice: ThemeChoice; label: string; icon: ReactNode }[] = [
  { choice: 'system', label: 'System', icon: <Monitor size={13} /> },
  { choice: 'light', label: 'Light', icon: <Sun size={13} /> },
  { choice: 'dark', label: 'Dark', icon: <Moon size={13} /> },
]

export function ThemePicker() {
  const choice = useApp((s) => s.themeChoice)
  const themeId = useApp((s) => s.themeId)
  const preferred = useApp((s) => s.preferred)

  const section = (mode: ThemeMode, title: string) => (
    <section>
      <h3 className="mb-2 text-xs font-medium text-dim">{title}</h3>
      <div className="grid grid-cols-3 gap-2.5">
        {THEMES.filter((theme) => theme.mode === mode).map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            inUse={theme.id === themeId}
            preferred={theme.id === preferred[mode]}
          />
        ))}
      </div>
    </section>
  )

  return (
    <Modal title="Theme" width="w-[620px] max-w-[94vw]">
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-xs font-medium text-dim">Appearance</h3>
          <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-md border border-line p-0.5">
            {MODES.map((mode) => (
              <button
                key={mode.choice}
                type="button"
                role="radio"
                aria-checked={choice === mode.choice}
                className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs ${
                  choice === mode.choice ? 'bg-accent text-on-accent' : 'text-dim hover:text-ink'
                }`}
                onClick={() => setThemeChoice(mode.choice)}
              >
                {mode.icon}
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        {section('dark', 'Dark themes')}
        {section('light', 'Light themes')}
        <p className="text-xs text-faint">
          One theme is remembered for dark and one for light. Switching appearance, or the system doing so, uses the
          theme chosen for that side.
        </p>
      </div>
    </Modal>
  )
}

/** A small mock of the app drawn in the theme's own colours. */
function ThemeCard({ theme, inUse, preferred }: { theme: ThemeDef; inUse: boolean; preferred: boolean }) {
  const { ui, terminal } = theme
  const swatches = [terminal.red, terminal.green, terminal.yellow, terminal.blue, terminal.magenta, terminal.cyan]
  return (
    <button
      type="button"
      aria-pressed={inUse}
      aria-label={`${theme.name}${inUse ? ', in use' : preferred ? `, chosen for ${theme.mode}` : ''}`}
      className={`overflow-hidden rounded-md border text-left ${
        inUse ? 'border-accent ring-2 ring-accent/40' : preferred ? 'border-accent/60' : 'border-line hover:border-dim'
      }`}
      onClick={() => selectTheme(theme.id)}
    >
      <div className="flex h-16" style={{ background: ui.panel }}>
        <div className="flex w-9 flex-col gap-1 p-1.5" style={{ background: ui.sidebar }}>
          <span className="h-1.5 rounded-sm" style={{ background: ui.accent }} />
          <span className="h-1.5 rounded-sm" style={{ background: ui.line }} />
          <span className="h-1.5 rounded-sm" style={{ background: ui.line }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between p-2" style={{ background: terminal.background }}>
          <div className="space-y-1">
            <span className="block h-1 w-3/4 rounded-sm" style={{ background: terminal.foreground }} />
            <span className="block h-1 w-1/2 rounded-sm" style={{ background: ui.faint }} />
          </div>
          <div className="flex gap-1">
            {swatches.map((colour, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: A fixed list of swatches that never reorders, and colours can repeat.
              <span key={i} className="h-2 w-2 rounded-full" style={{ background: colour }} />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-1.5">
        <span className="truncate text-xs text-ink">{theme.name}</span>
        {(inUse || preferred) && <Check size={13} className={inUse ? 'shrink-0 text-accent' : 'shrink-0 text-faint'} />}
      </div>
    </button>
  )
}
