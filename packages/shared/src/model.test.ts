import { describe, expect, test } from 'bun:test'
import {
  type AppState,
  listPanes,
  makePane,
  makeSurface,
  makeWorkspace,
  type PaneNode,
  reduce,
  type Workspace,
} from './model'

function setup() {
  const first = makeSurface()
  const second = makeSurface()
  const pane = makePane([first, second])
  const workspace = makeWorkspace('ws', '/tmp', pane)
  const state: AppState = { rev: 1, workspaces: [workspace] }
  return { state, workspace, pane, first, second }
}

function split(state: AppState, workspace: Workspace, pane: PaneNode) {
  const newPane = makePane()
  const next = reduce(state, {
    type: 'pane.split',
    workspaceId: workspace.id,
    paneId: pane.id,
    direction: 'row',
    splitId: 'split_1',
    newPane,
  })
  return { next, newPane }
}

describe('reduce', () => {
  test('pane.split wraps the pane in an even split with the new pane second', () => {
    const { state, workspace, pane } = setup()
    const { next, newPane } = split(state, workspace, pane)
    expect(next.workspaces[0].root).toMatchObject({ type: 'split', ratio: 0.5, a: pane, b: newPane })
  })

  test('surface.close selects the neighbouring tab when the active one closes', () => {
    // A new pane starts with its first tab active.
    const { state, workspace, first, second } = setup()
    const next = reduce(state, {
      type: 'surface.close',
      workspaceId: workspace.id,
      surfaceId: first.id,
      fallback: makePane(),
    })
    expect(next.workspaces[0].root).toMatchObject({ surfaces: [second], activeSurfaceId: second.id })
  })

  test('surface.close collapses an emptied pane into its sibling', () => {
    const { state, workspace, pane } = setup()
    const { next, newPane } = split(state, workspace, pane)
    const closed = reduce(next, {
      type: 'surface.close',
      workspaceId: workspace.id,
      surfaceId: newPane.surfaces[0].id,
      fallback: makePane(),
    })
    expect(closed.workspaces[0].root).toBe(pane)
  })

  test('surface.close puts the fallback pane in when the last tab closes', () => {
    const surface = makeSurface()
    const workspace = makeWorkspace('ws', '/tmp', makePane([surface]))
    const fallback = makePane()
    const next = reduce(
      { rev: 1, workspaces: [workspace] },
      { type: 'surface.close', workspaceId: workspace.id, surfaceId: surface.id, fallback },
    )
    expect(next.workspaces[0].root).toBe(fallback)
  })

  test('surface.move moves the tab to the target pane and selects it', () => {
    const { state, workspace, pane, first } = setup()
    const { next, newPane } = split(state, workspace, pane)
    const moved = reduce(next, {
      type: 'surface.move',
      workspaceId: workspace.id,
      surfaceId: first.id,
      toPaneId: newPane.id,
      fallback: makePane(),
    })
    const [from, to] = listPanes(moved.workspaces[0].root)
    expect(from.surfaces.map((s) => s.id)).not.toContain(first.id)
    expect(to).toMatchObject({ activeSurfaceId: first.id })
    expect(to.surfaces.at(-1)).toBe(first)
  })

  test('split.resize clamps the ratio between 0.1 and 0.9', () => {
    const { state, workspace, pane } = setup()
    const { next } = split(state, workspace, pane)
    const resize = (ratio: number) =>
      reduce(next, { type: 'split.resize', workspaceId: workspace.id, splitId: 'split_1', ratio }).workspaces[0].root
    expect(resize(2)).toMatchObject({ ratio: 0.9 })
    expect(resize(-1)).toMatchObject({ ratio: 0.1 })
  })

  test('returns the same state object when nothing changes', () => {
    const { state, workspace, pane, first } = setup()
    // The first surface is already active, and the workspace id is unknown.
    expect(
      reduce(state, { type: 'surface.select', workspaceId: workspace.id, paneId: pane.id, surfaceId: first.id }),
    ).toBe(state)
    expect(reduce(state, { type: 'workspace.rename', workspaceId: 'missing', name: 'x' })).toBe(state)
  })
})
