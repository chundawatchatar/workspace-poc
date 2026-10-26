import type { Workspace } from '@orch/shared'
import { Bell, PanelLeft } from '@orch/ui/icons'
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { HostStatus } from '../components/HostStatus'
import { LayoutView } from '../components/LayoutView'
import { pendingAttention } from '../components/Sidebar'
import { revealSurface } from '../lib/commands'
import { shortPath } from '../lib/paths'
import { toggleSidebar, useApp } from '../lib/store'

export const Route = createFileRoute('/w/$workspaceId')({ component: WorkspacePage })

function WorkspacePage() {
  const { workspaceId } = Route.useParams()
  const loaded = useApp((s) => s.state !== null)
  const workspace = useApp((s) => s.state?.workspaces.find((w) => w.id === workspaceId))
  const name = workspace?.name

  useEffect(() => {
    if (name) document.title = `${name} · Workspaces`
  }, [name])

  if (!loaded) return <HostStatus />
  if (!workspace) return <Navigate to="/" replace />

  return (
    <>
      <Header workspace={workspace} />
      {/* Keyed by workspace so switching detaches the old terminals and attaches the new ones. */}
      <div key={workspace.id} className="anim-fade min-h-0 flex-1">
        <LayoutView workspace={workspace} />
      </div>
    </>
  )
}

function Header({ workspace }: { workspace: Workspace }) {
  const home = useApp((s) => s.info?.home)
  const button = 'rounded p-1.5 text-dim hover:bg-raised hover:text-ink'
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-sidebar px-2">
      <button
        type="button"
        title="Toggle sidebar"
        aria-label="Toggle sidebar"
        className={button}
        onClick={toggleSidebar}
      >
        <PanelLeft size={15} />
      </button>
      <span className="text-[13px] font-semibold">{workspace.name}</span>
      <span className="min-w-0 truncate font-mono text-xs text-faint">{shortPath(workspace.cwd, home)}</span>
      <div className="ml-auto flex items-center gap-0.5">
        <Notifications />
      </div>
    </header>
  )
}

function Notifications() {
  const workspaces = useApp((s) => s.state?.workspaces)
  const sessions = useApp((s) => s.sessions)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  const items = (workspaces ?? []).flatMap((workspace) =>
    pendingAttention(workspace, sessions).map((session) => ({ workspace, session })),
  )

  function jump(sessionId: string) {
    setOpen(false)
    const workspaceId = revealSurface(sessionId)
    if (workspaceId) void navigate({ to: '/w/$workspaceId', params: { workspaceId } })
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title="Notifications"
        aria-label={`Notifications, ${items.length} unread`}
        className="relative rounded p-1.5 text-dim hover:bg-raised hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        <Bell size={15} />
        {items.length > 0 && (
          <span className="absolute top-0.5 right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-on-accent">
            {items.length}
          </span>
        )}
      </button>
      {open && (
        <div className="anim-pop absolute top-9 right-0 z-40 w-72 rounded-md border border-line bg-raised py-1 shadow-xl">
          {items.length === 0 && <div className="px-3 py-3 text-xs text-dim">Nothing needs your attention.</div>}
          {items.map(({ workspace, session }) => (
            <button
              key={session.id}
              type="button"
              className="block w-full px-3 py-2 text-left hover:bg-accent/20"
              onClick={() => jump(session.id)}
            >
              <div className="truncate text-xs font-medium text-ink">{session.attention?.message}</div>
              <div className="truncate text-[11px] text-dim">
                {workspace.name} · {session.title}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
