import { stripAgentGlyphs } from '@orch/agents'
import {
  AGENT_LABELS,
  type AgentKind,
  type LayoutNode,
  listPanes,
  type PaneNode,
  type SplitNode,
  type Surface,
  type SurfaceKind,
  type Workspace,
} from '@orch/shared'
import { AgentIcon, ContextMenu, ContextMenuPopup, ContextMenuTrigger, MenuItem, TerminalInterrupted } from '@orch/ui'
import {
  Columns2,
  Copy,
  Eye,
  EyeOff,
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
import { type AgentStatus, agentStatus, withStatus } from '../lib/agentStatus'
import { SWITCH_HINT } from '../lib/agentTracking'
import {
  addSurface,
  closeSurface,
  copyWorkingFolder,
  moveSurface,
  selectSurface,
  splitPane,
  toggleZoom,
} from '../lib/commands'
import { shortPath } from '../lib/paths'
import {
  ackSession,
  dispatch,
  focusedPaneId,
  pushState,
  restoreSession,
  setAgentTracking,
  setFocus,
  useApp,
  zoomedPaneId,
} from '../lib/store'
import { AgentStateMark } from './AgentStateMark'
import { IssuesView, PullsView } from './SampleSurfaces'
import { pendingAttention } from './Sidebar'
import { TerminalView } from './TerminalView'

const DRAG_TYPE = 'application/x-poc-surface'

// The tab being dragged. Browsers hide drag data until the drop, so the pane
// under the pointer reads this to know where the tab came from.
let dragSource: { surfaceId: string; paneId: string } | null = null

export function LayoutView({ workspace }: { workspace: Workspace }) {
  // A lone pane fills the page with no frame, since there is no other pane the typing could go to.
  if (listPanes(workspace.root).length === 1)
    return <NodeView workspace={workspace} node={workspace.root} split={false} />
  return (
    <div className="h-full w-full bg-bg p-1">
      <NodeView workspace={workspace} node={workspace.root} split />
    </div>
  )
}

function NodeView({ workspace, node, split }: { workspace: Workspace; node: LayoutNode; split: boolean }) {
  return node.type === 'pane' ? (
    <PaneView workspace={workspace} pane={node} split={split} />
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
        <NodeView workspace={workspace} node={split.a} split />
      </div>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        // The pseudo-element reaches 2px into each pane, so the 4px gap is easier to grab.
        className={`group relative z-10 shrink-0 before:absolute ${
          row
            ? 'w-1 cursor-col-resize before:inset-y-0 before:-inset-x-0.5'
            : 'h-1 cursor-row-resize before:inset-x-0 before:-inset-y-0.5'
        }`}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          pushState()
        }}
      >
        <div className="absolute inset-0 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-70" />
      </div>
      <div className="min-h-0 min-w-0" style={{ flex: `${1 - split.ratio} 1 0%` }}>
        <NodeView workspace={workspace} node={split.b} split />
      </div>
    </div>
  )
}

/**
 * The title a tab shows. Agents' own spinner and status glyphs come off both
 * ends, since the tab draws its own mark, and a title left empty reads
 * `Terminal`. Shells title a tab `user@host:/long/path`; the last folder is what
 * identifies it.
 */
export function tidyTitle(raw: string, kind?: AgentKind) {
  const title = stripAgentGlyphs(raw, kind)
  if (!title) return 'Terminal'
  const match = /^[^@\s]+@[^:\s]+:\s*(.+)$/.exec(title)
  if (!match) return title
  return match[1].split('/').filter(Boolean).pop() ?? '/'
}

const KIND_ICON: Record<SurfaceKind, ReactNode> = {
  terminal: <SquareTerminal size={13} />,
  pulls: <GitPullRequest size={13} />,
  issues: <KanbanSquare size={13} />,
}

/**
 * A tab's icon: which agent runs in it, or else the status of its program, or
 * else its kind. An agent's status draws after the title instead, so the icon
 * stays the same through every state.
 */
export function SurfaceIcon(props: { kind: SurfaceKind; agent: AgentKind | null; status: AgentStatus | null }) {
  if (props.agent) return <AgentIcon kind={props.agent} size={13} />
  return props.status ? <AgentStateMark status={props.status} size={13} /> : KIND_ICON[props.kind]
}

/** The tooltip of a tab: its title, then its status, or the agent's name when the agent has no known state. */
function tabTooltip(title: string, agent: AgentKind | null, status: AgentStatus | null) {
  return agent && !status ? `${title}\n${AGENT_LABELS[agent]}` : withStatus(title, status)
}

/**
 * The edge of a pane in a split workspace, with the accent on the focused one. Every pane keeps the same border and
 * only its colour follows focus, so moving focus never shifts the layout. A lone or full-screen pane has none.
 */
function paneFrame(framed: boolean, focused: boolean) {
  if (!framed) return { className: '', focusFrame: false }
  return {
    className: `overflow-hidden rounded-md border ${focused ? 'border-accent' : 'border-line'}`,
    focusFrame: focused,
  }
}

/** A pane of the layout. `split` is true when the workspace has more than one pane, so each pane gets a frame. */
function PaneView({ workspace, pane, split }: { workspace: Workspace; pane: PaneNode; split: boolean }) {
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

  // Keeps the active tab in view when the tabs don't all fit.
  useEffect(() => {
    const tab = tabBar.current?.querySelector(`[data-tab-id="${CSS.escape(pane.activeSurfaceId)}"]`)
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [pane.activeSurfaceId])

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
  const frame = paneFrame(split && !zoomed, focused)

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
      data-focus-frame={frame.focusFrame ? '' : undefined}
      className={`flex h-full w-full min-h-0 min-w-0 flex-col bg-panel ${zoomed ? 'fixed inset-0 z-40' : 'relative'} ${frame.className} ${
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
        {/* The tabs, then New terminal, then empty space. When the tabs don't fit they scroll and New terminal stays put. */}
        <div
          className="flex min-w-0 flex-1 items-stretch"
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
          <div
            ref={tabBar}
            className="tab-strip flex min-w-0 items-stretch overflow-x-auto"
            onWheel={(event) => {
              // The scrollbar is hidden, so a plain mouse wheel scrolls the tabs sideways.
              if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
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
                  surface.kind === 'terminal'
                    ? tidyTitle(sessions[surface.id]?.title ?? surface.title, sessions[surface.id]?.agent?.kind)
                    : surface.title
                }
                attention={Boolean(sessions[surface.id]?.attention)}
                agent={sessions[surface.id]?.agent?.kind ?? null}
                status={agentStatus(sessions[surface.id])}
                tracking={sessions[surface.id]?.agentTracking}
              />
            ))}
          </div>
          <button
            type="button"
            title="New terminal"
            aria-label="New terminal"
            className="mx-1 shrink-0 self-center rounded p-1 text-dim hover:bg-raised hover:text-ink"
            onClick={() => addSurface(workspace, pane.id, 'terminal')}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1.5 text-dim">
          {zoomed && (
            <span className="mr-1 rounded bg-zoom/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zoom uppercase">
              Full screen
            </span>
          )}
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
                <div className="relative h-full">
                  <TerminalView
                    sessionId={surface.id}
                    cwd={workspace.cwd}
                    active={visible && focused && !overlayOpen}
                  />
                  <Interrupted sessionId={surface.id} />
                </div>
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
      {activeAttention && (
        <div className="attention-ring pointer-events-none absolute inset-0 z-20 rounded-[inherit]" />
      )}
    </div>
  )
}

/** Offers to resume the agent of a terminal the daemon lost, while it is interrupted. */
function Interrupted({ sessionId }: { sessionId: string }) {
  const interrupted = useApp((s) => s.sessions[sessionId]?.interrupted)
  const home = useApp((s) => s.info?.home)
  if (!interrupted) return null
  return (
    <TerminalInterrupted
      agent={AGENT_LABELS[interrupted.agent.kind]}
      sessionId={interrupted.agent.sessionId}
      cwd={shortPath(interrupted.cwd, home)}
      command={interrupted.command}
      onResume={() => restoreSession(sessionId, 'agent')}
      onShell={() => restoreSession(sessionId, 'shell')}
    />
  )
}

function Tab(props: {
  workspace: Workspace
  pane: PaneNode
  surface: Surface
  title: string
  paneFocused: boolean
  attention: boolean
  /** The agent running in the terminal; null when none is identified. */
  agent: AgentKind | null
  status: AgentStatus | null
  /** The terminal's per-session switch; undefined until the host reports the session. */
  tracking: boolean | undefined
  /** Shows where a dragged tab would be inserted relative to this one. */
  marker?: 'before' | 'after'
}) {
  const { workspace, pane, surface, title, paneFocused, attention, agent, status, tracking, marker } = props
  const active = pane.activeSurfaceId === surface.id
  return (
    // Only terminals have a menu; other tabs keep the browser's.
    <ContextMenu disabled={surface.kind !== 'terminal'}>
      <ContextMenuTrigger
        render={
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
            title={tabTooltip(title, agent, status)}
            className={`anim-fade group flex max-w-52 min-w-24 cursor-default items-center gap-1.5 border-r border-line px-2.5 text-xs select-none ${
              active ? `bg-panel ${paneFocused ? 'text-ink' : 'text-dim'}` : 'text-faint hover:text-dim'
            } ${
              marker === 'before'
                ? 'shadow-[inset_2px_0_0_var(--color-accent)]'
                : marker === 'after'
                  ? 'shadow-[inset_-2px_0_0_var(--color-accent)]'
                  : ''
            }`}
          />
        }
      >
        <span className={active && paneFocused ? 'text-accent' : ''}>
          <SurfaceIcon kind={surface.kind} agent={agent} status={status} />
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {attention && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        {/* Kept at the mark's width with no state too, so a change of state never moves the title or Close. */}
        {agent && (
          <span data-slot="status" className="flex w-[13px] shrink-0 justify-center">
            {status && <AgentStateMark status={status} size={13} />}
          </span>
        )}
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
      </ContextMenuTrigger>
      <ContextMenuPopup aria-label={`${title} tab`} className="w-48">
        <MenuItem icon={<Copy size={13} />} onClick={() => void copyWorkingFolder(surface.id, workspace.cwd)}>
          Copy working folder
        </MenuItem>
        {tracking !== undefined && (
          <MenuItem
            icon={tracking ? <EyeOff size={13} /> : <Eye size={13} />}
            title={SWITCH_HINT}
            onClick={() => setAgentTracking(surface.id, !tracking)}
          >
            {tracking ? 'Stop tracking the agent' : 'Track the agent again'}
          </MenuItem>
        )}
      </ContextMenuPopup>
    </ContextMenu>
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
