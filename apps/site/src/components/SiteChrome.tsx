import { LEADER_LABEL } from '@orch/terminal-ui/shortcut-rows'
import { ThemePicker } from '@orch/ui/ThemePicker'
import { Toast } from '@orch/ui/Toast'
import { themeById } from '@orch/ui/themes'
import { useEffect, useRef, useState } from 'react'
import type { PaletteAction, PaletteItem } from '../lib/palette'
import { chooseMode, readTheme, selectTheme, type ThemeState, toggleMode, watchSystemTheme } from '../lib/theme'
import { copyText, type ToastMessage } from '../lib/toast'
import { CommandPalette } from './CommandPalette'
import { ShortcutSheet } from './ShortcutSheet'

type Overlay = 'palette' | 'help' | 'themes' | null

interface Props {
  items: PaletteItem[]
  installCommand: string
  /** Section ids in sidebar order, for Ctrl+B then 1–9. */
  sections: string[]
}

function toggleSidebar() {
  const root = document.documentElement
  if (matchMedia('(min-width: 1024px)').matches) root.toggleAttribute('data-sidebar-hidden')
  else root.classList.toggle('drawer-open')
}

function goToSection(id: string) {
  const target = document.getElementById(id)
  if (target) target.scrollIntoView()
  else window.location.href = `/#${id}`
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

const MODIFIERS = ['Shift', 'Control', 'Meta', 'Alt']

/** ⌘P on Mac, Ctrl+Shift+P elsewhere: the app's palette keys. */
function isPaletteKey(event: KeyboardEvent) {
  return (
    event.code === 'KeyP' &&
    !event.altKey &&
    ((event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.shiftKey && !event.metaKey))
  )
}

function isLeaderKey(event: KeyboardEvent) {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === 'KeyB'
}

/** The key pressed after the leader. */
function runLeader(event: KeyboardEvent, sections: string[], open: (overlay: Overlay) => void) {
  const digit = /^Digit([1-9])$/.exec(event.code)
  const section = digit ? sections[Number(digit[1]) - 1] : undefined
  if (section) goToSection(section)
  else if (event.key === '?' || event.code === 'Slash') open('help')
  else if (event.code === 'KeyT') open('themes')
  else if (event.code === 'KeyB') toggleSidebar()
}

/**
 * The window chrome the app has, on the site: the command palette, the Ctrl+B leader key, the shortcut sheet,
 * the theme picker and toasts. Static buttons open them with `data-open="palette|help|themes"` or
 * `data-action="toggle-theme|sidebar"`.
 */
export function SiteChrome({ items, installCommand, sections }: Props) {
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [theme, setTheme] = useState<ThemeState | null>(null)
  const [message, setMessage] = useState<ToastMessage | null>(null)
  const leader = useRef(false)

  useEffect(() => {
    setTheme(readTheme())
    watchSystemTheme()
    const onTheme = (event: Event) => setTheme((event as CustomEvent<ThemeState>).detail)
    let timer = 0
    const onToast = (event: Event) => {
      setMessage((event as CustomEvent<ToastMessage>).detail)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setMessage(null), 2200)
    }
    window.addEventListener('orch:theme', onTheme)
    window.addEventListener('orch:toast', onToast)
    return () => {
      window.removeEventListener('orch:theme', onTheme)
      window.removeEventListener('orch:toast', onToast)
    }
  }, [])

  useEffect(() => {
    const setLeader = (on: boolean) => {
      leader.current = on
      document.documentElement.toggleAttribute('data-leader', on)
    }

    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-open], [data-action]')
      if (!target) return
      const open = target.dataset.open as Overlay | undefined
      if (open) setOverlay(open)
      if (target.dataset.action === 'toggle-theme') toggleMode()
      if (target.dataset.action === 'sidebar') toggleSidebar()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteKey(event)) {
        event.preventDefault()
        setOverlay((current) => (current === 'palette' ? null : 'palette'))
      } else if (event.key === 'Escape') {
        setLeader(false)
        setOverlay(null)
        document.documentElement.classList.remove('drawer-open')
      } else if (event.metaKey && !event.ctrlKey && event.code === 'KeyB') {
        event.preventDefault()
        toggleSidebar()
      } else if (isLeaderKey(event)) {
        event.preventDefault()
        setLeader(!leader.current)
      } else if (leader.current && !isTyping(event.target) && !MODIFIERS.includes(event.key)) {
        event.preventDefault()
        setLeader(false)
        runLeader(event, sections, setOverlay)
      }
    }

    document.addEventListener('click', onClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [sections])

  function run(item: PaletteItem) {
    setOverlay(null)
    if (item.href) {
      const hash = item.href.startsWith('/#') ? item.href.slice(2) : null
      if (hash && document.getElementById(hash)) goToSection(hash)
      else window.location.href = item.href
      return
    }
    const actions: Record<PaletteAction, () => void> = {
      'toggle-theme': toggleMode,
      themes: () => setOverlay('themes'),
      help: () => setOverlay('help'),
      'copy-install': () => copyText(installCommand, 'Install command copied'),
      sidebar: toggleSidebar,
    }
    if (item.action) actions[item.action]()
  }

  return (
    <>
      {overlay === 'palette' && <CommandPalette items={items} onRun={run} onClose={() => setOverlay(null)} />}
      {overlay === 'help' && <ShortcutSheet leaderLabel={LEADER_LABEL} onClose={() => setOverlay(null)} />}
      {overlay === 'themes' && theme && (
        <ThemePicker
          choice={theme.choice}
          themeId={theme.themeId}
          preferred={theme.preferred}
          onChoose={chooseMode}
          onSelect={(id) => {
            const picked = themeById(id)
            if (picked) selectTheme(picked.id, picked.mode)
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {message && <Toast message={message.message} kind={message.kind} />}
    </>
  )
}
