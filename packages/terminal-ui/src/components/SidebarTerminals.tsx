import { AGENT_LABELS, type AgentKind, listPanes, type SessionInfo, type Workspace } from '@orch/shared'
import { AgentIcon } from '@orch/ui'
import { useEffect, useState } from 'react'
import { type AgentStatus, agentStatus, type SidebarSignal, sidebarSignal, withStatus } from '../lib/agentStatus'
import { revealSurface } from '../lib/commands'
import { shortPath } from '../lib/paths'
import { useApp } from '../lib/store'
import { useGoToWorkspace } from '../navigation'
import { AgentStateMark } from './AgentStateMark'
import { tidyTitle } from './LayoutView'

const COLLAPSED_KEY = 'poc-sidebar-collapsed'

function readCollapsed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/** Whether a workspace's terminal list is collapsed, remembered per workspace in this browser. */
export function useCollapsed(workspaceId: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().includes(workspaceId))
  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    const ids = readCollapsed().filter((id) => id !== workspaceId)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next ? [...ids, workspaceId] : ids))
    } catch {}
  }
  return [collapsed, toggle]
}

/** How long something has been running, in its largest unit: `45s`, `12m`, `3h 5m`, `2d`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export function terminalIds(workspace: Workspace) {
  return listPanes(workspace.root)
    .flatMap((pane) => pane.surfaces)
    .filter((surface) => surface.kind === 'terminal')
    .map((surface) => surface.id)
}

/** One line per terminal in a workspace: what it runs, where, and for how long. Clicking one opens it. */
export function SidebarTerminals({ workspace, active }: { workspace: Workspace; active: boolean }) {
  const sessions = useApp((s) => s.sessions)
  const home = useApp((s) => s.info?.home)
  const shell = useApp((s) => s.info?.shell.split('/').pop() ?? 'shell')
  const goToWorkspace = useGoToWorkspace()
  const now = useNow(5000)
  const ids = terminalIds(workspace)

  function open(event: React.MouseEvent, id: string) {
    // The list sits inside the workspace's link; this click opens a terminal instead.
    event.preventDefault()
    event.stopPropagation()
    const workspaceId = revealSurface(id)
    if (workspaceId) goToWorkspace(workspaceId)
  }

  if (ids.length === 0) return null
  return (
    <ul className={`mt-1.5 space-y-px border-l pl-1.5 ${active ? 'border-on-accent/30' : 'border-line'}`}>
      {ids.map((id) => {
        const session = sessions[id] as SessionInfo | undefined
        const agent = session?.agent?.kind
        const status = agentStatus(session)
        const marks = { signal: sidebarSignal(session, status), status, active }
        const running = session?.process
        const interrupted = session?.interrupted
        const name = interrupted
          ? `${AGENT_LABELS[interrupted.agent.kind]} · interrupted`
          : (running?.name ?? (session && !session.alive ? 'exited' : shell))
        return (
          <li key={id}>
            <button
              type="button"
              title={withStatus(running?.command ?? tidyTitle(session?.title ?? 'Terminal'), status)}
              className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] ${
                active ? 'hover:bg-on-accent/15' : 'hover:bg-line'
              }`}
              onClick={(event) => open(event, id)}
            >
              <RowStart agent={agent} {...marks} />
              {/* The path gives way first, then the name truncates, so the marks at the end stay in the row. */}
              <span
                className={`min-w-0 truncate font-medium ${running ? '' : active ? 'text-on-accent/60' : 'text-dim'}`}
              >
                {name}
              </span>
              <span className={`min-w-0 flex-1 truncate ${active ? 'text-on-accent/60' : 'text-faint'}`}>
                {session?.cwd ? shortPath(session.cwd, home) : ''}
              </span>
              {running && (
                <span className={`shrink-0 tabular-nums ${active ? 'text-on-accent/60' : 'text-faint'}`}>
                  {formatElapsed(now - running.startedAt)}
                </span>
              )}
              {agent && <AgentRowEnd {...marks} />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** What a row's marks are drawn from. `active` is true on the selected workspace's tile. */
interface SignalProps {
  signal: SidebarSignal
  status: AgentStatus | null
  active: boolean
}

/** The start of a row: which agent runs in it, or else the signal `sidebarSignal` chose. */
function RowStart(props: { agent: AgentKind | undefined } & SignalProps) {
  const { agent, ...marks } = props
  return (
    <span className="flex w-3 shrink-0 justify-center">
      {agent ? <AgentIcon kind={agent} size={10} /> : <SignalMark {...marks} />}
    </span>
  )
}

/**
 * The end of an agent's row: the attention dot when `sidebarSignal` chose it,
 * then the status slot, which keeps its width when empty so a change of state
 * never moves the row. Attention outranks only an idle mark, which still shows.
 */
function AgentRowEnd(props: SignalProps) {
  const { signal, status, active } = props
  const attention = signal === 'attention'
  return (
    <>
      {attention && <SignalMark signal="attention" status={null} active={active} />}
      <span data-slot="status" className="flex w-3 shrink-0 justify-center">
        {attention ? (
          status && <AgentStateMark status={status} size={10} onAccent={active} />
        ) : (
          <SignalMark signal={signal} status={status} active={active} />
        )}
      </span>
    </>
  )
}

/**
 * Draws the signal `sidebarSignal` chose for a row. A row with no agent shows
 * it in its leading slot, and an agent's row at its end.
 */
function SignalMark(props: SignalProps) {
  const { signal, status, active } = props
  if (status && signal === 'status') return <AgentStateMark status={status} size={10} onAccent={active} />
  const dot = 'h-1.5 w-1.5 shrink-0 rounded-full'
  if (signal === 'attention')
    return <span data-signal="attention" className={`${dot} ${active ? 'bg-on-accent' : 'bg-accent'}`} />
  // On the selected tile's accent background, an outline keeps the green and red dots visible.
  const outline = active ? 'ring-1 ring-on-accent' : ''
  if (signal === 'interrupted')
    return <span data-signal="interrupted" className={`${dot} bg-warn ${outline}`} title="Interrupted" />
  if (signal === 'running') return <span data-signal="running" className={`${dot} bg-good ${outline}`} />
  if (signal === 'exited')
    return <span data-signal="exited" className={`${dot} ${active ? 'bg-bad' : 'bg-bad/70'} ${outline}`} />
  return <span data-signal="shell" className={`${dot} border ${active ? 'border-on-accent/60' : 'border-faint'}`} />
}
