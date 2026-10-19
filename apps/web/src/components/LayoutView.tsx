import type { LayoutNode, PaneNode, SplitNode, Surface, SurfaceKind, Workspace } from '@orch/shared'
import {
  Columns2,
  GitPullRequest,
  KanbanSquare,
  Maximize2,
  Minimize2,
  Plus,
  Rows2,
  SquareTerminal,
  X,
} from '@orch/ui/icons'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { addSurface, closeSurface, moveSurface, selectSurface, splitPane, toggleZoom } from '../lib/commands'
import { ackSession, dispatch, focusedPaneId, pushState, setFocus, useApp, zoomedPaneId } from '../lib/store'
import { IssuesView, PullsView } from './SampleSurfaces'
import { pendingAttention } from './Sidebar'
import { TerminalView } from './TerminalView'

const DRAG_TYPE = 'application/x-poc-surface'

// The tab being dragged. Browsers hide drag data until the drop, so the pane
// under the pointer reads this to know where the tab came from.
let dragSource: { surfaceId: string; paneId: string } | null = null

export function LayoutView({ workspace }: { workspace: Workspace }) {
  return <NodeView workspace={workspace} node={workspace.root} />
}

function NodeView({ workspace, node }: { workspace: Workspace; node: LayoutNode }) {
  return node.type === 'pane' ? (
    <PaneView workspace={workspace} pane={node} />
  ) : (
    <SplitView workspace={workspace} split={node} />
  )
}

function SplitView({ workspace, split }: { workspace: Workspace; split: SplitNode }) {
  const container = useRef<HTMLDivElement>(null)
  const row = split.direction === 'row'

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return
    const rect = container.current.getBoundingClientRect()
    const ratio = row ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height
    // Local only while dragging; the host hears about it once, on release.
    dispatch({ type: 'split.resize', workspaceId: workspace.id, splitId: split.id, ratio }, false)
  }

  return (
    <div ref={container} className={`flex h-full w-full min-h-0 min-w-0 ${row ? 'flex-row' : 'flex-col'}`}>
      <div className="min-h-0 min-w-0" style={{ flex: `${split.ratio} 1 0%` }}>
        <NodeView workspace={workspace} node={split.a} />
      </div>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        className={`group relative z-10 shrink-0 bg-line ${row ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}`}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          pushState()
        }}
      >
        <div
          className={`absolute bg-accent opacity-0 transition-opacity group-hover:opacity-70 ${
            row ? '-left-[2px] top-0 h-full w-[5px]' : '-top-[2px] left-0 h-[5px] w-full'
          }`}
        />
      </div>
      <div className="min-h-0 min-w-0" style={{ flex: `${1 - split.ratio} 1 0%` }}>
        <NodeView workspace={workspace} node={split.b} />
      </div>
    </div>
  )
}

/** Shells title a tab `user@host:/long/path`; the last folder is what identifies it. */
export function tidyTitle(title: string) {
  const match = /^[^@\s]+@[^:\s]+:\s*(.+)$/.exec(title)
  if (!match) return title
  return match[1].split('/').filter(Boolean).pop() ?? '/'
}

const KIND_ICON: Record<SurfaceKind, ReactNode> = {
  terminal: <SquareTerminal size={13} />,
  pulls: <GitPullRequest size={13} />,
  issues: <KanbanSquare size={13} />,
}

function PaneView({ workspace, pane }: { workspace: Workspace; pane: PaneNode }) {
  const focused = useApp((s) => focusedPaneId(workspace, s.focus) === pane.id)
  const sessions = useApp((s) => s.sessions)
  const zoomed = useApp((s) => zoomedPaneId(workspace, s.zoom) === pane.id)
  // A dialog holds the keyboard while it is open; the terminal takes it back when the dialog closes.
  const overlayOpen = useApp((s) => s.overlay !== null)
  const workspaces = useApp((s) => s.state?.workspaces)
  const [dropTarget, setDropTarget] = useState(false)
  // Where a dragged tab would land in this pane's tab bar, as a position among its tabs.
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const tabBar = useRef<HTMLDivElement>(null)

  const indexAt = (clientX: number) => {
    let index = 0
    for (const tab of tabBar.current?.querySelectorAll('[data-tab-id]') ?? []) {
      const rect = tab.getBoundingClientRect()
      if (clientX > rect.left + rect.width / 2) index++
    }
    return index
  }

  // A drag can end anywhere, including outside the window; clear the markers when it does.
  useEffect(() => {
    const clear = () => {
      setDropIndex(null)
      setDropTarget(false)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  // No marker where dropping would leave the tab exactly where it is.
  const draggedFrom =
    dragSource?.paneId === pane.id ? pane.surfaces.findIndex((s) => s.id === dragSource?.surfaceId) : -1
  const markerIndex =
    dropIndex === null || (draggedFrom !== -1 && (dropIndex === draggedFrom || dropIndex === draggedFrom + 1))
      ? null
      : dropIndex
  // Full screen covers the sidebar and the bell, so the exit button carries the signal instead.
  const attentionElsewhere =
    zoomed &&
    (workspaces ?? []).some((w) =>
      pendingAttention(w, sessions).some((session) => !pane.surfaces.some((s) => s.id === session.id)),
    )
  const activeAttention = sessions[pane.activeSurfaceId]?.attention ?? null

  // Looking at a terminal counts as having seen its notification.
  useEffect(() => {
    if (!activeAttention || !focused) return
    const acknowledge = () => {
      if (document.hasFocus()) ackSession(pane.activeSurfaceId)
    }
    acknowledge()
    window.addEventListener('focus', acknowledge)
    return () => window.removeEventListener('focus', acknowledge)
  }, [activeAttention, focused, pane.activeSurfaceId])

  return (
    <div
      data-pane-id={pane.id}
      className={`flex h-full w-full min-h-0 min-w-0 flex-col bg-panel ${zoomed ? 'fixed inset-0 z-40' : 'relative'} ${
        dropTarget ? 'outline outline-2 -outline-offset-2 outline-accent/60' : ''
      }`}
      onPointerDownCapture={() => setFocus(workspace.id, pane.id)}
      onDragOver={(event) => {
        // Over the body, a tab from another pane is dropped at the end. One from this pane has nowhere to go.
        if (!event.dataTransfer.types.includes(DRAG_TYPE) || dragSource?.paneId === pane.id) return
        event.preventDefault()
        setDropTarget(true)
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(event) => {
        setDropTarget(false)
        const surfaceId = event.dataTransfer.getData(DRAG_TYPE)
        if (surfaceId) moveSurface(workspace, surfaceId, pane.id)
      }}
    >
      <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-sidebar">
        <div
          ref={tabBar}
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
          onDoubleClick={(event) => event.target === event.currentTarget && toggleZoom(workspace, pane.id)}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
            event.preventDefault()
            event.stopPropagation()
            setDropTarget(false)
            setDropIndex(indexAt(event.clientX))
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null)
          }}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const surfaceId = event.dataTransfer.getData(DRAG_TYPE)
            const index = indexAt(event.clientX)
            setDropIndex(null)
            if (surfaceId) moveSurface(workspace, surfaceId, pane.id, index)
          }}
        >
          {pane.surfaces.map((surface, i) => (
            <Tab
              marker={
                markerIndex === i
                  ? 'before'
                  : markerIndex === pane.surfaces.length && i === pane.surfaces.length - 1
                    ? 'after'
                    : undefined
              }
              key={surface.id}
              workspace={workspace}
              pane={pane}
              surface={surface}
              paneFocused={focused}
              title={
                surface.kind === 'terminal' ? tidyTitle(sessions[surface.id]?.title ?? surface.title) : surface.title
              }
              attention={Boolean(sessions[surface.id]?.attention)}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5 text-dim">
          {zoomed && (
            <span className="mr-1 rounded bg-zoom/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zoom uppercase">
              Full screen
            </span>
          )}
          <AddMenu onAdd={(kind) => addSurface(workspace, pane.id, kind)} />
          {!zoomed && (
            <>
              <IconButton label="Split right" onClick={() => splitPane(workspace, pane.id, 'row')}>
                <Columns2 size={14} />
              </IconButton>
              <IconButton label="Split down" onClick={() => splitPane(workspace, pane.id, 'column')}>
                <Rows2 size={14} />
              </IconButton>
            </>
          )}
          <IconButton
            label={
              !zoomed
                ? 'Full screen'
                : attentionElsewhere
                  ? 'Exit full screen (another terminal needs attention)'
                  : 'Exit full screen'
            }
            onClick={() => toggleZoom(workspace, pane.id)}
          >
            <span className="relative block">
              {zoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {attentionElsewhere && <span className="absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-accent" />}
            </span>
          </IconButton>
        </div>
      </div>

      <div className={`relative min-h-0 flex-1 transition-opacity ${focused ? '' : 'opacity-70'}`}>
        {pane.surfaces.map((surface) => {
          const visible = surface.id === pane.activeSurfaceId
          return (
            <div key={surface.id} className={`absolute inset-0 ${visible ? '' : 'pointer-events-none invisible'}`}>
              {surface.kind === 'terminal' ? (
                <TerminalView sessionId={surface.id} cwd={workspace.cwd} active={visible && focused && !overlayOpen} />
              ) : surface.kind === 'pulls' ? (
                <PullsView />
              ) : (
                <IssuesView />
              )}
            </div>
          )
        })}
      </div>

      {zoomed && <div className="zoom-frame anim-fade pointer-events-none absolute inset-0 z-20" />}
      {activeAttention && <div className="attention-ring pointer-events-none absolute inset-0 z-20" />}
    </div>
  )
}

function Tab(props: {
  workspace: Workspace
  pane: PaneNode
  surface: Surface
  title: string
  paneFocused: boolean
  attention: boolean
  /** Shows where a dragged tab would be inserted relative to this one. */
  marker?: 'before' | 'after'
}) {
  const { workspace, pane, surface, title, paneFocused, attention, marker } = props
  const active = pane.activeSurfaceId === surface.id
  return (
    <div
      draggable
      data-tab-id={surface.id}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, surface.id)
        event.dataTransfer.effectAllowed = 'move'
        dragSource = { surfaceId: surface.id, paneId: pane.id }
      }}
      onDragEnd={() => {
        dragSource = null
      }}
      onClick={() => selectSurface(workspace, pane.id, surface.id)}
      title={title}
      className={`anim-fade group flex max-w-52 min-w-24 cursor-default items-center gap-1.5 border-r border-line px-2.5 text-xs select-none ${
        active ? `bg-panel ${paneFocused ? 'text-ink' : 'text-dim'}` : 'text-faint hover:text-dim'
      } ${
        marker === 'before'
          ? 'shadow-[inset_2px_0_0_var(--color-accent)]'
          : marker === 'after'
            ? 'shadow-[inset_-2px_0_0_var(--color-accent)]'
            : ''
      }`}
    >
      <span className={active && paneFocused ? 'text-accent' : ''}>{KIND_ICON[surface.kind]}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {attention && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-raised"
        onClick={(event) => {
          event.stopPropagation()
          closeSurface(workspace, surface.id)
        }}
      >
        <X size={12} />
      </button>
    </div>
  )
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      className="rounded p-1 hover:bg-raised hover:text-ink"
    >
      {props.children}
    </button>
  )
}

function AddMenu({ onAdd }: { onAdd: (kind: SurfaceKind) => void }) {
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

  const items: { kind: SurfaceKind; label: string }[] = [
    { kind: 'terminal', label: 'Terminal' },
    // Disabled for now while the app focuses on the terminal.
    // { kind: 'pulls', label: 'Pull requests' },
    // { kind: 'issues', label: 'Issues' },
  ]

  return (
    <div ref={root} className="relative">
      <IconButton label="New tab" onClick={() => setOpen(!open)}>
        <Plus size={14} />
      </IconButton>
      {open && (
        <div className="anim-pop absolute top-7 right-0 z-30 w-44 rounded-md border border-line bg-raised py-1 shadow-xl">
          {items.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink hover:bg-accent/20"
              onClick={() => {
                setOpen(false)
                onAdd(item.kind)
              }}
            >
              <span className="text-dim">{KIND_ICON[item.kind]}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
