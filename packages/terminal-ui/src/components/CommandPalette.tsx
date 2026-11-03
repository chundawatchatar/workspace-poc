import {
  AGENT_LABELS,
  type AgentTrackingAnswer,
  type AgentTrackingStatus,
  listPanes,
  type SessionInfo,
  type SurfaceKind,
  type TrackedAgent,
  trackedAgent,
  type Workspace,
} from '@orch/shared'
import { Dialog, THEMES } from '@orch/ui'
import { ChevronRight, GitPullRequest, KanbanSquare, LayoutGrid, Search, SquareTerminal } from '@orch/ui/icons'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { SWITCH_SHORT_HINT, useAgentTrackingAnswers, useAnswerAgentTracking } from '../lib/agentTracking'
import {
  addSurface,
  closeSurface,
  currentPane,
  cycleSurface,
  revealSurface,
  splitPane,
  toggleZoom,
} from '../lib/commands'
import { shortPath } from '../lib/paths'
import {
  restoreSession,
  selectTheme,
  setAgentTracking,
  setOverlay,
  setThemeChoice,
  toggleSidebar,
  useApp,
} from '../lib/store'
import { useNavigation } from '../navigation'
import { usePageOptions } from '../pageOptions'
import { tidyTitle } from './LayoutView'

interface Item {
  id: string
  group: 'Workspace' | 'Tab' | 'Command'
  icon: ReactNode
  label: string
  /** Secondary text, also searched. */
  hint?: string
  keys?: string
  run: () => void
}

const TAB_ICON: Record<SurfaceKind, ReactNode> = {
  terminal: <SquareTerminal size={14} />,
  pulls: <GitPullRequest size={14} />,
  issues: <KanbanSquare size={14} />,
}

/** Lower is better; null means no match. Whole-word and prefix matches beat scattered letters. */
function score(text: string, query: string): number | null {
  const haystack = text.toLowerCase()
  const at = haystack.indexOf(query)
  if (at === 0) return 0
  if (at > 0) return haystack[at - 1] === ' ' ? 1 : 2
  let matched = 0
  for (const char of haystack) {
    if (char === query[matched]) matched++
    if (matched === query.length) return 10
  }
  return null
}

function rank(item: Item, query: string): number | null {
  const byLabel = score(item.label, query)
  const byHint = item.hint ? score(item.hint, query) : null
  if (byLabel === null && byHint === null) return null
  return Math.min(byLabel ?? Infinity, byHint === null ? Infinity : byHint + 5)
}

function tabItems(workspace: Workspace, sessions: Record<string, SessionInfo>, go: (id: string) => void): Item[] {
  return listPanes(workspace.root).flatMap((pane) =>
    pane.surfaces.map((surface) => ({
      id: `tab:${surface.id}`,
      group: 'Tab',
      icon: TAB_ICON[surface.kind],
      label: surface.kind === 'terminal' ? tidyTitle(sessions[surface.id]?.title ?? surface.title) : surface.title,
      hint: sessions[surface.id]?.attention ? `${workspace.name} · needs attention` : workspace.name,
      run: () => {
        const target = revealSurface(surface.id)
        if (target) go(target)
      },
    })),
  )
}

/**
 * The tracking switch of the focused terminal, when there is one, and a command per agent kind to change its
 * stored trust answer, once the answers are known.
 */
function trackingCommands(
  focused: SessionInfo | undefined,
  answers: AgentTrackingStatus | undefined,
  answer: (agent: TrackedAgent, answer: AgentTrackingAnswer) => void,
) {
  const items: { label: string; run: () => void; hint: string }[] = []
  if (focused) {
    const on = focused.agentTracking
    items.push({
      label: on ? 'Stop tracking the agent in this terminal' : 'Track the agent in this terminal again',
      run: () => setAgentTracking(focused.id, !on),
      hint: SWITCH_SHORT_HINT,
    })
  }
  for (const kind of answers ? trackedAgent.options : []) {
    const on = answers?.[kind] === 'on'
    items.push({
      label: `${on ? 'Stop tracking' : 'Track'} ${AGENT_LABELS[kind]} with hooks`,
      run: () => answer(kind, on ? 'off' : 'on'),
      hint: 'Applies to agents started afterwards',
    })
  }
  return items
}

export function CommandPalette() {
  const { workspaceId, navigate } = useNavigation()
  const { remoteAccessSetting } = usePageOptions()
  const workspaces = useApp((s) => s.state?.workspaces)
  const sessions = useApp((s) => s.sessions)
  const home = useApp((s) => s.info?.home)
  const answers = useAgentTrackingAnswers()
  const { answer } = useAnswerAgentTracking()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo(() => {
    const all = workspaces ?? []
    const current = all.find((w) => w.id === workspaceId)
    const go = (id: string) => navigate({ workspaceId: id })
    const result: Item[] = []

    all.forEach((workspace, i) => {
      if (workspace.id === workspaceId) return
      result.push({
        id: `ws:${workspace.id}`,
        group: 'Workspace',
        icon: <LayoutGrid size={14} />,
        label: workspace.name,
        hint: shortPath(workspace.cwd, home),
        keys: i < 9 ? `Ctrl+Shift+${i + 1}` : undefined,
        run: () => go(workspace.id),
      })
    })

    for (const workspace of all) {
      result.push(...tabItems(workspace, sessions, go))
    }

    const command = (label: string, run: () => void, keys?: string, hint?: string) =>
      result.push({ id: `cmd:${label}`, group: 'Command', icon: <ChevronRight size={14} />, label, keys, hint, run })

    if (current) {
      const pane = () => currentPane(current)
      command('Split right', () => splitPane(current, pane().id, 'row'), 'Ctrl+Shift+D')
      command('Split down', () => splitPane(current, pane().id, 'column'), 'Ctrl+Shift+E')
      command('New terminal tab', () => addSurface(current, pane().id, 'terminal'), 'Ctrl+Shift+Enter')
      // Disabled for now while the app focuses on the terminal.
      // command('New pull requests tab', () => addSurface(current, pane().id, 'pulls'))
      // command('New issues tab', () => addSurface(current, pane().id, 'issues'))
      command('Close tab', () => closeSurface(current, pane().activeSurfaceId), 'Ctrl+Shift+X')
      command('Next tab', () => cycleSurface(current, 1), 'Ctrl+Shift+]')
      command('Previous tab', () => cycleSurface(current, -1), 'Ctrl+Shift+[')
      command('Toggle full screen', () => toggleZoom(current), 'Ctrl+Shift+F')
      const activeId = pane().activeSurfaceId
      if (sessions[activeId]?.interrupted) {
        command('Resume interrupted agent', () => restoreSession(activeId, 'agent'))
        command('Open a plain shell instead', () => restoreSession(activeId, 'shell'))
      }
    }
    const focused = current && sessions[currentPane(current).activeSurfaceId]
    for (const item of trackingCommands(focused, answers, answer)) command(item.label, item.run, undefined, item.hint)
    command('New workspace', () => setOverlay('new-workspace'), 'Ctrl+B W')
    command('Toggle sidebar', toggleSidebar, 'Ctrl+B B  ·  ⌘B')
    command('Choose theme…', () => setOverlay('themes'), 'Ctrl+B T')
    command('Appearance: Light', () => setThemeChoice('light'))
    command('Appearance: Dark', () => setThemeChoice('dark'))
    command('Appearance: Follow system', () => setThemeChoice('system'))
    for (const theme of THEMES) command(`Theme: ${theme.name}`, () => selectTheme(theme.id))
    command('Show keyboard shortcuts', () => setOverlay('help'), 'Ctrl+B ?')
    if (remoteAccessSetting) command('Remote access…', () => setOverlay('remote-access'))
    return result
  }, [workspaces, sessions, home, workspaceId, navigate, remoteAccessSetting, answers, answer])

  const visible = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return items
    return items
      .map((item, order) => ({ item, order, rank: rank(item, trimmed) }))
      .filter((entry): entry is { item: Item; order: number; rank: number } => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((entry) => entry.item)
  }, [items, query])

  const selected = Math.min(index, Math.max(0, visible.length - 1))

  // biome-ignore lint/correctness/useExhaustiveDependencies: The dependencies are the trigger: scroll when the selection or the list changes.
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, visible])

  function run(item: Item | undefined) {
    if (!item) return
    // Close first: some commands open another dialog.
    setOverlay(null)
    item.run()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex(visible.length ? (selected + 1) % visible.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex(visible.length ? (selected - 1 + visible.length) % visible.length : 0)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      run(visible[selected])
    }
  }

  return (
    <Dialog
      aria-label="Command palette"
      backdropClassName="bg-black/45"
      viewportClassName="pt-[12vh]"
      className="flex max-h-[62vh] w-[580px] max-w-[92vw] flex-col overflow-hidden"
      onClose={() => setOverlay(null)}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3">
        <Search size={15} className="shrink-0 text-faint" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={visible[selected] ? `palette-${visible[selected].id}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search workspaces, tabs and commands"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        <kbd>Esc</kbd>
      </div>
      <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {visible.length === 0 && <div className="px-3 py-6 text-center text-xs text-dim">No matches.</div>}
        {visible.map((item, i) => (
          <div
            key={item.id}
            id={`palette-${item.id}`}
            role="option"
            aria-selected={i === selected}
            data-selected={i === selected}
            className={`flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 ${
              i === selected ? 'bg-accent text-on-accent' : 'text-ink'
            }`}
            onPointerMove={() => i !== selected && setIndex(i)}
            onClick={() => run(item)}
          >
            <span className={i === selected ? 'text-on-accent/80' : 'text-dim'}>{item.icon}</span>
            <span className="min-w-0 truncate text-[13px]">{item.label}</span>
            {item.hint && (
              <span className={`min-w-0 truncate text-xs ${i === selected ? 'text-on-accent/70' : 'text-faint'}`}>
                {item.hint}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {item.keys && (
                <span className={`font-mono text-[11px] ${i === selected ? 'text-on-accent/80' : 'text-dim'}`}>
                  {item.keys}
                </span>
              )}
              <span
                className={`w-[70px] text-right text-[10px] tracking-wide uppercase ${
                  i === selected ? 'text-on-accent/60' : 'text-faint'
                }`}
              >
                {item.group}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
