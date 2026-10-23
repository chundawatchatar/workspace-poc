import { AGENT_LABELS, listPanes, type SessionInfo, type Workspace } from '@orch/shared'
import { CircleAlert, LoaderCircle } from '@orch/ui/icons'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { revealSurface } from '../lib/commands'
import { useApp } from '../lib/store'
import { tidyTitle } from './LayoutView'
import { shortPath } from './Sidebar'

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
  const navigate = useNavigate()
  const now = useNow(5000)
  const ids = terminalIds(workspace)

  function open(event: React.MouseEvent, id: string) {
    // The list sits inside the workspace's link; this click opens a terminal instead.
    event.preventDefault()
    event.stopPropagation()
    const workspaceId = revealSurface(id)
    if (workspaceId) void navigate({ to: '/w/$workspaceId', params: { workspaceId } })
  }

  if (ids.length === 0) return null
  return (
    <ul className={`mt-1.5 space-y-px border-l pl-1.5 ${active ? 'border-on-accent/30' : 'border-line'}`}>
      {ids.map((id) => {
        const session = sessions[id] as SessionInfo | undefined
        const running = session?.process
        const interrupted = session?.interrupted
        const name = interrupted
          ? `${AGENT_LABELS[interrupted.agent.kind]} · interrupted`
          : (running?.name ?? (session && !session.alive ? 'exited' : shell))
        return (
          <li key={id}>
            <button
              type="button"
              title={running?.command ?? tidyTitle(session?.title ?? 'Terminal')}
              className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] ${
                active ? 'hover:bg-on-accent/15' : 'hover:bg-line'
              }`}
              onClick={(event) => open(event, id)}
            >
              <span className="flex w-3 shrink-0 justify-center">
                <StatusMark session={session} active={active} />
              </span>
              <span className={`shrink-0 font-medium ${running ? '' : active ? 'text-on-accent/60' : 'text-dim'}`}>
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
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function StatusMark({ session, active }: { session: SessionInfo | undefined; active: boolean }) {
  if (session?.progress === 'busy') return <LoaderCircle size={10} className="animate-spin" aria-label="Working" />
  if (session?.progress === 'error') return <CircleAlert size={10} className="text-bad" aria-label="Failed" />
  const dot = 'h-1.5 w-1.5 rounded-full'
  if (session?.attention) return <span className={`${dot} ${active ? 'bg-on-accent' : 'bg-accent'}`} />
  // On the selected tile's accent background, an outline keeps the green and red dots visible.
  const outline = active ? 'ring-1 ring-on-accent' : ''
  if (session?.interrupted) return <span className={`${dot} bg-warn ${outline}`} title="Interrupted" />
  if (session?.process) return <span className={`${dot} bg-good ${outline}`} />
  if (session && !session.alive) return <span className={`${dot} ${active ? 'bg-bad' : 'bg-bad/70'} ${outline}`} />
  return <span className={`${dot} border ${active ? 'border-on-accent/60' : 'border-faint'}`} />
}
