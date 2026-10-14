import { type GitInfo, listPanes, type SessionInfo, type Workspace } from '@poc/shared'
import { Link, useNavigate } from '@tanstack/react-router'
import { GitBranch, Keyboard, Moon, Palette, Plus, Sun, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { removeWorkspace, renameWorkspace } from '../lib/commands'
import { LEADER_LABEL } from '../lib/shortcuts'
import { SIDEBAR_WIDTH, setSidebarWidth, sidebarWidth } from '../lib/sidebarWidth'
import { HOST_HTTP, setOverlay, toggleThemeMode, useApp } from '../lib/store'

export function shortPath(path: string, home: string | undefined) {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function useGitInfo(cwd: string): GitInfo | null {
  const [info, setInfo] = useState<GitInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch(`${HOST_HTTP}/api/git?cwd=${encodeURIComponent(cwd)}`)
        .then((response) => response.json() as Promise<GitInfo>)
        .then((next) => !cancelled && setInfo(next))
        .catch(() => {})
    load()
    const timer = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [cwd])
  return info
}

/** Sessions in a workspace that are waiting to be looked at, newest first. */
export function pendingAttention(workspace: Workspace, sessions: Record<string, SessionInfo>) {
  return listPanes(workspace.root)
    .flatMap((pane) => pane.surfaces)
    .map((surface) => sessions[surface.id])
    .filter((session): session is SessionInfo => Boolean(session?.attention))
    .sort((a, b) => (b.attention?.at ?? 0) - (a.attention?.at ?? 0))
}

export function Sidebar({ activeId, open }: { activeId: string | undefined; open: boolean }) {
  const workspaces = useApp((s) => s.state?.workspaces)
  const status = useApp((s) => s.status)
  const leader = useApp((s) => s.leader)

  return (
    // The shell animates between the sidebar's width and zero; the sidebar inside keeps its width and is clipped.
    <div className="sidebar-shell" data-open={open} inert={!open}>
    <aside
      className="relative flex h-full flex-col border-r border-line bg-sidebar"
      style={{ width: `var(--sidebar-width, ${SIDEBAR_WIDTH.initial}px)` }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">Workspaces</span>
        <button
          type="button"
          title="New workspace"
          aria-label="New workspace"
          className="rounded p-1 text-dim hover:bg-raised hover:text-ink"
          onClick={() => setOverlay('new-workspace')}
        >
          <Plus size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {workspaces?.map((workspace, index) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            index={index}
            active={workspace.id === activeId}
            fallbackId={workspaces.find((w) => w.id !== workspace.id)?.id}
          />
        ))}
      </nav>

      <div className="flex h-9 shrink-0 items-center justify-between border-t border-line px-3 text-xs text-dim">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'open' ? 'bg-good' : status === 'connecting' ? 'bg-warn' : 'bg-bad'
            }`}
          />
          {status === 'open' ? 'Host connected' : status === 'connecting' ? 'Connecting…' : 'Host offline'}
        </span>
        {leader ? (
          <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-on-accent">
            {LEADER_LABEL} …
          </span>
        ) : (
          <span className="flex items-center">
            <ThemeButtons />
            <button
              type="button"
              title="Keyboard shortcuts"
              aria-label="Keyboard shortcuts"
              className="rounded p-1 hover:bg-raised hover:text-ink"
              onClick={() => setOverlay('help')}
            >
              <Keyboard size={14} />
            </button>
          </span>
        )}
      </div>
      <ResizeHandle />
    </aside>
    </div>
  )
}

/** The draggable right edge of the sidebar. Double-click resets it; arrow keys nudge it. */
function ResizeHandle() {
  const [dragging, setDragging] = useState(false)
  const [width, setWidth] = useState(SIDEBAR_WIDTH.initial)

  useEffect(() => setWidth(sidebarWidth()), [])

  const widthAt = (event: React.PointerEvent<HTMLDivElement>) =>
    event.clientX - (event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className={`absolute top-0 right-0 z-30 h-full w-[5px] cursor-col-resize outline-none transition-colors focus-visible:bg-accent/60 ${
        dragging ? 'bg-accent/70' : 'hover:bg-accent/50'
      }`}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        // Turns off the open/close animation so the edge follows the pointer exactly.
        document.documentElement.dataset.resizing = 'true'
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(widthAt(event), false)
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        event.currentTarget.releasePointerCapture(event.pointerId)
        delete document.documentElement.dataset.resizing
        setDragging(false)
        setWidth(setSidebarWidth(widthAt(event)))
      }}
      onDoubleClick={() => setWidth(setSidebarWidth(SIDEBAR_WIDTH.initial))}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
        if (!step) return
        event.preventDefault()
        setWidth(setSidebarWidth(sidebarWidth() + step))
      }}
    />
  )
}

function ThemeButtons() {
  const theme = useApp((s) => s.theme)
  const button = 'rounded p-1 hover:bg-raised hover:text-ink'
  const toggleLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <>
      <button type="button" title={toggleLabel} aria-label={toggleLabel} className={button} onClick={toggleThemeMode}>
        {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
      </button>
      <button
        type="button"
        title="Choose theme"
        aria-label="Choose theme"
        className={button}
        onClick={() => setOverlay('themes')}
      >
        <Palette size={14} />
      </button>
    </>
  )
}

function WorkspaceRow(props: {
  workspace: Workspace
  index: number
  active: boolean
  fallbackId: string | undefined
}) {
  const { workspace, index, active, fallbackId } = props
  const sessions = useApp((s) => s.sessions)
  const home = useApp((s) => s.info?.home)
  const git = useGitInfo(workspace.cwd)
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState(false)
  const pending = pendingAttention(workspace, sessions)

  function remove(event: React.MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (!window.confirm(`Close workspace "${workspace.name}" and end its terminals?`)) return
    removeWorkspace(workspace.id)
    if (active) {
      if (fallbackId) void navigate({ to: '/w/$workspaceId', params: { workspaceId: fallbackId } })
      else void navigate({ to: '/' })
    }
  }

  return (
    <Link
      to="/w/$workspaceId"
      params={{ workspaceId: workspace.id }}
      className={`group relative block rounded-md px-2.5 py-2 ${
        active ? 'bg-accent text-on-accent' : 'text-ink hover:bg-raised'
      }`}
    >
      <div className="flex items-center gap-2">
        {renaming ? (
          <input
            autoFocus
            defaultValue={workspace.name}
            className="min-w-0 flex-1 rounded bg-black/30 px-1 text-[13px] font-semibold outline-none"
            onClick={(event) => event.preventDefault()}
            onBlur={(event) => {
              renameWorkspace(workspace.id, event.target.value)
              setRenaming(false)
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-semibold"
            title="Double-click to rename"
            onDoubleClick={(event) => {
              event.preventDefault()
              setRenaming(true)
            }}
          >
            {workspace.name}
          </span>
        )}
        {pending.length > 0 && (
          <span
            className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
              active ? 'bg-on-accent text-accent' : 'bg-accent text-on-accent'
            }`}
          >
            {pending.length}
          </span>
        )}
        {index < 9 && pending.length === 0 && (
          <span className={`text-[10px] group-hover:hidden ${active ? 'text-on-accent/60' : 'text-faint'}`}>
            {index + 1}
          </span>
        )}
        <button
          type="button"
          aria-label={`Close workspace ${workspace.name}`}
          className={`hidden rounded p-0.5 group-hover:block ${active ? 'hover:bg-on-accent/20' : 'hover:bg-line'}`}
          onClick={remove}
        >
          <X size={12} />
        </button>
      </div>

      {pending.length > 0 && (
        <div className={`mt-0.5 truncate text-xs ${active ? 'text-on-accent/90' : 'text-accent'}`}>
          {pending[0].attention?.message}
        </div>
      )}

      <div className={`mt-0.5 flex items-center gap-1 text-[11px] ${active ? 'text-on-accent/70' : 'text-dim'}`}>
        {git?.branch && (
          <>
            <GitBranch size={10} className="shrink-0" />
            <span className="max-w-24 truncate">{git.branch}</span>
            {git.changes > 0 && <span>· {git.changes} changed</span>}
            <span>·</span>
          </>
        )}
        <span className="min-w-0 truncate" title={workspace.cwd}>
          {shortPath(workspace.cwd, home)}
        </span>
      </div>
    </Link>
  )
}
