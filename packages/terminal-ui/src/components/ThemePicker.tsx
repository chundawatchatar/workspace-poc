import { ThemePicker as ThemePickerView } from '@orch/ui'
import { selectTheme, setOverlay, setThemeChoice, useApp } from '../lib/store'

export function ThemePicker() {
  const choice = useApp((s) => s.themeChoice)
  const themeId = useApp((s) => s.themeId)
  const preferred = useApp((s) => s.preferred)
  return (
    <ThemePickerView
      choice={choice}
      themeId={themeId}
      preferred={preferred}
      onChoose={setThemeChoice}
      onSelect={selectTheme}
      onClose={() => setOverlay(null)}
    />
  )
}
