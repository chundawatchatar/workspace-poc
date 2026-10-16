import {
  findPane,
  findPaneOfSurface,
  listPanes,
  locateSurface,
  makePane,
  makeSurface,
  makeWorkspace,
  newId,
  reduce,
  type SurfaceKind,
  type Workspace,
} from '@poc/shared'
import { dispatch, focusedPaneId, getSnapshot, mutate, setFocus, toggleZoom as toggleZoomState } from './store'
import { placeSurface } from './tabOrder'
import { withPaneTransition } from './transition'

// Every way of triggering an action (button, shortcut, leader key) calls these.

export function currentPane(workspace: Workspace) {
  const paneId = focusedPaneId(workspace, getSnapshot().focus)
  return findPane(workspace.root, paneId) ?? listPanes(workspace.root)[0]
}

export function splitPane(workspace: Workspace, paneId: string, direction: 'row' | 'column') {
  const newPane = makePane()
  withPaneTransition(() => {
    dispatch({
      type: 'pane.split',
      workspaceId: workspace.id,
      paneId,
      direction,
      splitId: newId('split'),
      newPane,
    })
    setFocus(workspace.id, newPane.id)
  })
}

export function addSurface(workspace: Workspace, paneId: string, kind: SurfaceKind = 'terminal') {
  dispatch({ type: 'surface.add', workspaceId: workspace.id, paneId, surface: makeSurface(kind) })
  setFocus(workspace.id, paneId)
}

export function closeSurface(workspace: Workspace, surfaceId: string) {
  const fallback = makePane()
  withPaneTransition(() => dispatch({ type: 'surface.close', workspaceId: workspace.id, surfaceId, fallback }))
}

/**
 * Moves a tab to a pane. With `toIndex` it lands at that position among the
 * pane's tabs, which is also how a tab is reordered within its own pane;
 * without it, the tab goes to the end of another pane.
 */
export function moveSurface(workspace: Workspace, surfaceId: string, toPaneId: string, toIndex?: number) {
  const from = findPaneOfSurface(workspace.root, surfaceId)
  if (!from) return
  const samePane = from.id === toPaneId
  if (samePane && toIndex === undefined) return
  const fallback = makePane()
  const update = () => {
    mutate((state) => {
      const moved = samePane
        ? state
        : reduce(state, { type: 'surface.move', workspaceId: workspace.id, surfaceId, toPaneId, fallback })
      return toIndex === undefined ? moved : placeSurface(moved, workspace.id, toPaneId, surfaceId, toIndex)
    })
    setFocus(workspace.id, toPaneId)
  }
  // Panes only change shape when the tab changes pane; a reorder needs no animation.
  if (samePane) update()
  else withPaneTransition(update)
}

export function selectSurface(workspace: Workspace, paneId: string, surfaceId: string) {
  dispatch({ type: 'surface.select', workspaceId: workspace.id, paneId, surfaceId })
  setFocus(workspace.id, paneId)
}

/** Selects a tab and focuses its pane. Returns the workspace to show, or nothing if the tab is gone. */
export function revealSurface(surfaceId: string): string | undefined {
  const state = getSnapshot().state
  const found = state && locateSurface(state, surfaceId)
  if (!found) return undefined
  selectSurface(found.workspace, found.pane.id, surfaceId)
  return found.workspace.id
}

export function cycleSurface(workspace: Workspace, step: 1 | -1) {
  const pane = currentPane(workspace)
  const index = pane.surfaces.findIndex((s) => s.id === pane.activeSurfaceId)
  const next = pane.surfaces[(index + step + pane.surfaces.length) % pane.surfaces.length]
  selectSurface(workspace, pane.id, next.id)
}

export function cyclePane(workspace: Workspace) {
  const panes = listPanes(workspace.root)
  const index = panes.findIndex((p) => p.id === currentPane(workspace).id)
  setFocus(workspace.id, panes[(index + 1) % panes.length].id)
}

/** Makes a pane fill the app window, or returns it to its place in the layout. */
export function toggleZoom(workspace: Workspace, paneId: string = currentPane(workspace).id) {
  withPaneTransition(() => {
    setFocus(workspace.id, paneId)
    toggleZoomState(workspace.id, paneId)
  }, paneId)
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/** Moves focus to the nearest pane in a direction, judged by where panes are on screen. */
export function focusDirection(workspace: Workspace, direction: Direction) {
  const current = document.querySelector<HTMLElement>(`[data-pane-id="${currentPane(workspace).id}"]`)
  if (!current) return
  const from = current.getBoundingClientRect()
  const cx = from.left + from.width / 2
  const cy = from.top + from.height / 2
  let best: { id: string; distance: number } | null = null
  for (const element of document.querySelectorAll<HTMLElement>('[data-pane-id]')) {
    if (element === current) continue
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const ahead =
      direction === 'left'
        ? rect.right <= from.left + 1
        : direction === 'right'
          ? rect.left >= from.right - 1
          : direction === 'up'
            ? rect.bottom <= from.top + 1
            : rect.top >= from.bottom - 1
    if (!ahead) continue
    const horizontal = direction === 'left' || direction === 'right'
    // Distance along the direction of travel, with drift across it counted double.
    const distance = horizontal ? Math.abs(x - cx) + 2 * Math.abs(y - cy) : Math.abs(y - cy) + 2 * Math.abs(x - cx)
    if (!best || distance < best.distance) best = { id: element.dataset.paneId as string, distance }
  }
  if (best) setFocus(workspace.id, best.id)
}

export function addWorkspace(name: string, cwd: string): string {
  const workspace = makeWorkspace(name, cwd)
  dispatch({ type: 'workspace.add', workspace })
  return workspace.id
}

export function removeWorkspace(workspaceId: string) {
  dispatch({ type: 'workspace.remove', workspaceId })
}

export function renameWorkspace(workspaceId: string, name: string) {
  const trimmed = name.trim()
  if (trimmed) dispatch({ type: 'workspace.rename', workspaceId, name: trimmed })
}
