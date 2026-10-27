import type { Workspace } from '@orch/shared'
import { useEffect, useRef } from 'react'
import {
  addSurface,
  closeSurface,
  currentPane,
  cyclePane,
  cycleSurface,
  type Direction,
  focusDirection,
  splitPane,
  toggleZoom,
} from './commands'
import { getSnapshot, setLeader, setOverlay, toggleSidebar } from './store'

// Browsers keep a few keys for themselves (Ctrl/Cmd+W, T, N and tab switching),
// so every command has a leader sequence that works everywhere, plus a direct
// Ctrl+Shift combination. On macOS, Cmd+D and Cmd+B from cmux also work.

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

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

function isLeader(event: KeyboardEvent) {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyB'
}

function digit(event: KeyboardEvent): number | null {
  const match = /^Digit([1-9])$/.exec(event.code)
  return match ? Number(match[1]) : null
}

export function useShortcuts(workspace: Workspace | undefined, goToWorkspace: (id: string) => void) {
  // The listener is installed once; these refs keep it reading current values.
  const workspaceRef = useRef(workspace)
  const goRef = useRef(goToWorkspace)
  workspaceRef.current = workspace
  goRef.current = goToWorkspace

  useEffect(() => {
    let leaderTimer: ReturnType<typeof setTimeout> | undefined

    function goToIndex(index: number) {
      const target = getSnapshot().state?.workspaces[index - 1]
      if (target) goRef.current(target.id)
    }

    /** Commands that act on the open workspace. Returns false if the key is not one of them. */
    function workspaceCommand(name: string): boolean {
      const ws = workspaceRef.current
      if (!ws) return false
      const pane = currentPane(ws)
      switch (name) {
        case 'split-right':
          splitPane(ws, pane.id, 'row')
          return true
        case 'split-down':
          splitPane(ws, pane.id, 'column')
          return true
        case 'new-tab':
          addSurface(ws, pane.id)
          return true
        case 'close-tab':
          closeSurface(ws, pane.activeSurfaceId)
          return true
        case 'next-tab':
          cycleSurface(ws, 1)
          return true
        case 'prev-tab':
          cycleSurface(ws, -1)
          return true
        case 'next-pane':
          cyclePane(ws)
          return true
        case 'zoom':
          toggleZoom(ws, pane.id)
          return true
        default:
          if (name in ARROWS) {
            focusDirection(ws, ARROWS[name])
            return true
          }
          return false
      }
    }

    function afterLeader(event: KeyboardEvent) {
      const n = digit(event)
      if (n) return goToIndex(n)
      if (event.key in ARROWS) return void workspaceCommand(event.key)
      switch (event.key.toLowerCase()) {
        case 'd':
        case '%':
          return void workspaceCommand('split-right')
        case 'e':
        case '"':
          return void workspaceCommand('split-down')
        case 'c':
          return void workspaceCommand('new-tab')
        case 'x':
          return void workspaceCommand('close-tab')
        case 'n':
          return void workspaceCommand('next-tab')
        case 'p':
          return void workspaceCommand('prev-tab')
        case 'o':
          return void workspaceCommand('next-pane')
        case 'z':
          return void workspaceCommand('zoom')
        case 'w':
          return setOverlay('new-workspace')
        case 'b':
          return toggleSidebar()
        case 't':
          return setOverlay('themes')
        case '?':
        case '/':
          return setOverlay('help')
      }
    }

    function direct(event: KeyboardEvent): boolean {
      const cmdOnly = event.metaKey && !event.ctrlKey && !event.altKey
      if (cmdOnly && event.code === 'KeyD') return workspaceCommand(event.shiftKey ? 'split-down' : 'split-right')
      if (cmdOnly && !event.shiftKey && event.code === 'KeyB') {
        toggleSidebar()
        return true
      }
      if (!(event.ctrlKey && event.shiftKey) || event.metaKey || event.altKey) return false
      const n = digit(event)
      if (n) {
        goToIndex(n)
        return true
      }
      if (event.key in ARROWS) return workspaceCommand(event.key)
      switch (event.code) {
        case 'KeyD':
          return workspaceCommand('split-right')
        case 'KeyE':
          return workspaceCommand('split-down')
        case 'Enter':
          return workspaceCommand('new-tab')
        case 'KeyX':
          return workspaceCommand('close-tab')
        case 'KeyF':
          return workspaceCommand('zoom')
        case 'BracketRight':
          return workspaceCommand('next-tab')
        case 'BracketLeft':
          return workspaceCommand('prev-tab')
        case 'Slash':
          setOverlay('help')
          return true
      }
      return false
    }

    function swallow(event: KeyboardEvent) {
      event.preventDefault()
      event.stopPropagation()
    }

    function onKeyDown(event: KeyboardEvent) {
      const snapshot = getSnapshot()
      // Cmd+P would otherwise print the page. Plain Ctrl+P is left alone: shells use it for history.
      const palette =
        event.code === 'KeyP' &&
        !event.altKey &&
        ((event.metaKey && !event.ctrlKey) || (event.ctrlKey && event.shiftKey && !event.metaKey))
      if (palette) {
        swallow(event)
        clearTimeout(leaderTimer)
        setLeader(false)
        setOverlay(snapshot.overlay === 'palette' ? null : 'palette')
        return
      }
      if (snapshot.overlay) {
        if (event.key === 'Escape') {
          swallow(event)
          setOverlay(null)
        }
        return
      }
      if (snapshot.leader) {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
        clearTimeout(leaderTimer)
        setLeader(false)
        // The leader twice lets the key through, so the terminal sends Ctrl+B itself, as in tmux.
        if (isLeader(event)) return
        swallow(event)
        if (event.key !== 'Escape') afterLeader(event)
        return
      }
      if (isLeader(event)) {
        swallow(event)
        setLeader(true)
        clearTimeout(leaderTimer)
        leaderTimer = setTimeout(() => setLeader(false), 2500)
        return
      }
      if (direct(event)) swallow(event)
    }

    // Capture phase, so a matching key never reaches the terminal underneath.
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      clearTimeout(leaderTimer)
    }
  }, [])
}
