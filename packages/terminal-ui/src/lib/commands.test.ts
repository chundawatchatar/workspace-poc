import { afterEach, describe, expect, test } from 'bun:test'
import { listPanes, makePane, makeSurface, makeWorkspace, type ServerEvent } from '@orch/shared'
import { getToast } from '@orch/ui'
import type { HostTransport } from '../transport'
import {
  addWorkspace,
  copyWorkingFolder,
  currentPane,
  focusDirection,
  moveSurface,
  renameWorkspace,
  revealSurface,
  workingFolder,
} from './commands'
import { connect, getSnapshot, setFocus } from './store'

let disconnect = () => {}
afterEach(() => {
  disconnect()
  document.body.replaceChildren()
  // Removing the own property brings back happy-dom's clipboard.
  Reflect.deleteProperty(navigator, 'clipboard')
})

function setup() {
  const tabs = [makeSurface('terminal'), makeSurface('terminal')]
  const left = makePane(tabs)
  const right = makePane()
  const workspace = makeWorkspace('main', '/repo', {
    type: 'split',
    id: 'split',
    direction: 'row',
    ratio: 0.5,
    a: left,
    b: right,
  })
  const socket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket
  const transport: HostTransport = { request: async () => Response.json({}), openSocket: () => socket }
  disconnect = connect(transport)
  const event: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [workspace] },
    sessions: [],
    info: { home: '/home', shell: 'zsh', platform: 'darwin', projectRoot: '/repo' },
  }
  socket.onmessage?.({ data: JSON.stringify(event) } as MessageEvent)
  const latest = () => {
    const current = getSnapshot().state?.workspaces[0]
    if (!current) throw new Error('Expected a workspace')
    return current
  }
  return { tabs, left, right, workspace, latest }
}

describe('layout commands', () => {
  test('reorders tabs, moves them between panes and collapses the emptied pane', () => {
    const { tabs, left, right, workspace, latest } = setup()
    expect(currentPane(workspace).id).toBe(left.id)
    const original = getSnapshot()
    moveSurface(workspace, 'missing', right.id)
    moveSurface(workspace, tabs[0].id, left.id)
    expect(getSnapshot()).toBe(original)
    moveSurface(latest(), tabs[0].id, left.id, 2)
    expect(listPanes(latest().root)[0].surfaces.map((s) => s.id)).toEqual([tabs[1].id, tabs[0].id])
    moveSurface(latest(), tabs[0].id, right.id, 0)
    expect(listPanes(latest().root)[1].surfaces[0].id).toBe(tabs[0].id)
    expect(getSnapshot().focus[workspace.id]).toBe(right.id)
    moveSurface(latest(), tabs[1].id, right.id)
    expect(latest().root.type).toBe('pane')
    expect(listPanes(latest().root)[0].surfaces.map((s) => s.id)).toEqual([
      tabs[0].id,
      right.surfaces[0].id,
      tabs[1].id,
    ])
  })

  test('reveals a tab by id in its pane and returns its workspace, ignoring an unknown id', () => {
    const { tabs, left, workspace, latest } = setup()
    expect(revealSurface(tabs[1].id)).toBe(workspace.id)
    expect(listPanes(latest().root).find((p) => p.id === left.id)?.activeSurfaceId).toBe(tabs[1].id)
    const before = getSnapshot()
    expect(revealSurface('missing')).toBeUndefined()
    expect(getSnapshot()).toBe(before)
  })

  test('focuses the closest pane in a direction and leaves focus alone when there is no candidate', () => {
    const { workspace, left, right } = setup()
    for (const [id, x, y] of [
      [left.id, 100, 100],
      [right.id, 200, 100],
      ['far', 400, 100],
      ['above', 100, 0],
      ['below', 100, 200],
    ] as const) {
      const element = document.createElement('div')
      element.dataset.paneId = id
      element.getBoundingClientRect = () => new DOMRect(x, y, 100, 100)
      document.body.append(element)
    }
    setFocus(workspace.id, left.id)
    focusDirection(workspace, 'right')
    expect(getSnapshot().focus[workspace.id]).toBe(right.id)
    focusDirection(workspace, 'left')
    expect(getSnapshot().focus[workspace.id]).toBe(left.id)
    focusDirection(workspace, 'up')
    expect(getSnapshot().focus[workspace.id]).toBe('above')
    setFocus(workspace.id, left.id)
    focusDirection(workspace, 'down')
    expect(getSnapshot().focus[workspace.id]).toBe('below')
    setFocus(workspace.id, left.id)
    focusDirection(workspace, 'left')
    expect(getSnapshot().focus[workspace.id]).toBe(left.id)
    // With no panes on screen there is nothing to move to.
    document.body.replaceChildren()
    focusDirection(workspace, 'right')
    expect(getSnapshot().focus[workspace.id]).toBe(left.id)
  })

  test('creates workspaces and ignores blank names when renaming', () => {
    setup()
    const id = addWorkspace('second', '/second')
    expect(getSnapshot().state?.workspaces[1]).toMatchObject({ id, name: 'second', cwd: '/second' })
    renameWorkspace(id, '   ')
    expect(getSnapshot().state?.workspaces[1].name).toBe('second')
    renameWorkspace(id, '  changed  ')
    expect(getSnapshot().state?.workspaces[1].name).toBe('changed')
  })
})

describe('workingFolder', () => {
  test("prefers the session's live folder and falls back to the workspace's", () => {
    const workspace = { cwd: '/repo' }
    expect(workingFolder({ cwd: '/repo/src' }, workspace)).toBe('/repo/src')
    expect(workingFolder({ cwd: null }, workspace)).toBe('/repo')
    expect(workingFolder({ cwd: '' }, workspace)).toBe('/repo')
    expect(workingFolder(undefined, workspace)).toBe('/repo')
  })
})

describe('copyWorkingFolder', () => {
  test('writes the full folder and confirms with a toast', async () => {
    const written: string[] = []
    await copyWorkingFolder('unknown-session', '/tmp/project', async (text) => {
      written.push(text)
    })
    expect(written).toEqual(['/tmp/project'])
    expect(getToast()).toMatchObject({ message: 'Copied /tmp/project', kind: 'info' })
  })

  test('shows an error toast instead of throwing when the clipboard fails or is missing', async () => {
    await copyWorkingFolder('unknown-session', '/tmp/project', () => Promise.reject(new Error('denied')))
    const rejected = getToast()
    expect(rejected).toMatchObject({ message: 'Could not copy folder', kind: 'error' })

    // No clipboard, like a browser on an insecure origin. The own property hides happy-dom's.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await copyWorkingFolder('unknown-session', '/tmp/project')
    expect(getToast()).toMatchObject({ message: 'Could not copy folder', kind: 'error' })
    expect(getToast()?.id).not.toBe(rejected?.id)
  })
})
