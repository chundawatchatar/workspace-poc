import { describe, expect, test } from 'bun:test'
import { type AppState, makePane, makeSurface, makeWorkspace, type PaneNode } from '@orch/shared'
import { placeSurface } from './tabOrder'

function setup() {
  const surfaces = [makeSurface(), makeSurface(), makeSurface()]
  const pane = makePane(surfaces)
  const workspace = makeWorkspace('ws', '/tmp', pane)
  const state: AppState = { rev: 1, workspaces: [workspace] }
  const order = (next: AppState) => (next.workspaces[0].root as PaneNode).surfaces.map((s) => surfaces.indexOf(s))
  return { state, workspace, pane, surfaces, order }
}

describe('placeSurface', () => {
  test('index counts positions with the moved tab still in place', () => {
    const { state, workspace, pane, surfaces, order } = setup()
    // "Before the third tab" moves the first tab to the middle.
    expect(order(placeSurface(state, workspace.id, pane.id, surfaces[0].id, 2))).toEqual([1, 0, 2])
    expect(order(placeSurface(state, workspace.id, pane.id, surfaces[2].id, 0))).toEqual([2, 0, 1])
  })

  test('selects the moved tab', () => {
    const { state, workspace, pane, surfaces } = setup()
    const next = placeSurface(state, workspace.id, pane.id, surfaces[1].id, 0)
    expect(next.workspaces[0].root).toMatchObject({ activeSurfaceId: surfaces[1].id })
  })

  test('returns the same state when the active tab stays put', () => {
    const { state, workspace, pane, surfaces } = setup()
    const active = placeSurface(state, workspace.id, pane.id, surfaces[0].id, 0)
    expect(placeSurface(active, workspace.id, pane.id, surfaces[0].id, 0)).toBe(active)
  })
})
