import { afterEach, describe, expect, test } from 'bun:test'
import { listPanes, makeWorkspace, type ServerEvent } from '@orch/shared'
import { renderHook } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HostTransport } from '../transport'
import { useShortcuts } from './shortcuts'
import { connect, getSnapshot, setLeader, setOverlay, useApp } from './store'

let disconnect = () => {}
afterEach(() => {
  disconnect()
  setLeader(false)
  setOverlay(null)
})

function setup() {
  const workspaces = [makeWorkspace('main', '/repo'), makeWorkspace('other', '/other')]
  const socket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket
  const transport: HostTransport = { request: async () => Response.json({}), openSocket: () => socket }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces },
    sessions: [],
    info: { home: '/home', shell: 'zsh', platform: 'darwin', projectRoot: '/repo' },
  }
  socket.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)
  const visited: string[] = []
  const hook = renderHook(() =>
    useShortcuts(
      useApp((s) => s.state?.workspaces[0]),
      (id) => visited.push(id),
    ),
  )
  return { ...hook, workspaces, visited }
}

function workspace() {
  const current = getSnapshot().state?.workspaces[0]
  if (!current) throw new Error('Expected a workspace')
  return current
}

const direct = (key: string) => `[ControlLeft>][ShiftLeft>]${key}[/ShiftLeft][/ControlLeft]`
const leader = (key: string) => `[ControlLeft>]b[/ControlLeft]${key}`

describe('keyboard shortcuts', () => {
  test('direct commands split, select tabs, zoom and close in the focused pane', async () => {
    const user = userEvent.setup()
    setup()
    await user.keyboard(direct('d'))
    expect(listPanes(workspace().root)).toHaveLength(2)
    const paneId = getSnapshot().focus[workspace().id]
    await user.keyboard(direct('{Enter}'))
    let pane = listPanes(workspace().root).find((p) => p.id === paneId)
    expect(pane?.surfaces).toHaveLength(2)
    const original = pane?.activeSurfaceId
    await user.keyboard(direct('[BracketLeft]'))
    pane = listPanes(workspace().root).find((p) => p.id === paneId)
    expect(pane?.activeSurfaceId).not.toBe(original)
    await user.keyboard(direct('[BracketRight]'))
    expect(listPanes(workspace().root).find((p) => p.id === paneId)?.activeSurfaceId).toBe(original)
    await user.keyboard(direct('f'))
    expect(getSnapshot().zoom[workspace().id]).toBe(paneId)
    await user.keyboard(direct('f'))
    expect(getSnapshot().zoom[workspace().id]).toBeUndefined()
    await user.keyboard(direct('x'))
    expect(listPanes(workspace().root).find((p) => p.id === paneId)?.surfaces).toHaveLength(1)
    await user.keyboard(direct('e'))
    expect(listPanes(workspace().root)).toHaveLength(3)
    expect(workspace().root.type).toBe('split')
  })

  test('leader sequences manage panes, tabs, overlays and workspace navigation', async () => {
    const user = userEvent.setup()
    const { visited, workspaces } = setup()
    await user.keyboard(leader('d'))
    expect(listPanes(workspace().root)).toHaveLength(2)
    const splitFocus = getSnapshot().focus[workspace().id]
    await user.keyboard(leader('o'))
    expect(getSnapshot().focus[workspace().id]).not.toBe(splitFocus)
    await user.keyboard(leader('e'))
    expect(listPanes(workspace().root)).toHaveLength(3)
    await user.keyboard(leader('c'))
    const currentId = getSnapshot().focus[workspace().id]
    const active = () => listPanes(workspace().root).find((p) => p.id === currentId)
    expect(active()?.surfaces).toHaveLength(2)
    const newTab = active()?.activeSurfaceId
    await user.keyboard(leader('p'))
    expect(active()?.activeSurfaceId).not.toBe(newTab)
    await user.keyboard(leader('n'))
    expect(active()?.activeSurfaceId).toBe(newTab)
    await user.keyboard(leader('z'))
    expect(getSnapshot().zoom[workspace().id]).toBe(currentId)
    await user.keyboard(leader('x'))
    expect(active()?.surfaces).toHaveLength(1)
    for (const [key, overlay] of [
      ['w', 'new-workspace'],
      ['t', 'themes'],
      ['/', 'help'],
    ] as const) {
      await user.keyboard(leader(key))
      expect(getSnapshot().overlay).toBe(overlay)
      await user.keyboard('{Escape}')
      expect(getSnapshot().overlay).toBeNull()
    }
    const sidebar = getSnapshot().sidebar
    await user.keyboard(leader('b'))
    expect(getSnapshot().sidebar).toBe(!sidebar)
    await user.keyboard(leader('b'))
    await user.keyboard(leader('2'))
    await user.keyboard(direct('2'))
    await user.keyboard(leader('9'))
    expect(visited).toEqual([workspaces[1].id, workspaces[1].id])
    expect(getSnapshot().leader).toBe(false)
  })

  test('leaves shell keys to the terminal, and a doubled or cancelled leader does nothing', async () => {
    const user = userEvent.setup()
    setup()
    const initial = getSnapshot().state
    await user.keyboard('[ControlLeft>]p[/ControlLeft]')
    expect(getSnapshot().overlay).toBeNull()
    await user.keyboard('[ControlLeft>]b[/ControlLeft]')
    expect(getSnapshot().leader).toBe(true)
    await user.keyboard('[ControlLeft>]b[/ControlLeft]')
    expect(getSnapshot().leader).toBe(false)
    await user.keyboard(leader('{Escape}'))
    expect(getSnapshot().leader).toBe(false)
    expect(getSnapshot().state).toBe(initial)
  })

  test('opens the palette and help directly, and ignores layout commands while an overlay is open', async () => {
    const user = userEvent.setup()
    setup()
    const initial = getSnapshot().state
    await user.keyboard('[MetaLeft>]p[/MetaLeft]')
    expect(getSnapshot().overlay).toBe('palette')
    await user.keyboard(direct('d'))
    expect(getSnapshot().state).toBe(initial)
    await user.keyboard('[MetaLeft>]p[/MetaLeft]')
    expect(getSnapshot().overlay).toBeNull()
    await user.keyboard(direct('p'))
    expect(getSnapshot().overlay).toBe('palette')
    await user.keyboard('{Escape}')
    await user.keyboard(direct('[Slash]'))
    expect(getSnapshot().overlay).toBe('help')
  })

  test('Cmd shortcuts toggle the sidebar and split the focused pane', async () => {
    const user = userEvent.setup()
    setup()
    const sidebar = getSnapshot().sidebar
    await user.keyboard('[MetaLeft>]b[/MetaLeft]')
    expect(getSnapshot().sidebar).toBe(!sidebar)
    await user.keyboard('[MetaLeft>]b[/MetaLeft]')
    await user.keyboard('[MetaLeft>]d[/MetaLeft]')
    expect(listPanes(workspace().root)).toHaveLength(2)
    await user.keyboard('[MetaLeft>][ShiftLeft>]d[/ShiftLeft][/MetaLeft]')
    expect(listPanes(workspace().root)).toHaveLength(3)
  })

  test('stops listening once unmounted', async () => {
    const user = userEvent.setup()
    const { unmount } = setup()
    unmount()
    const stopped = getSnapshot()
    await user.keyboard(direct('d'))
    expect(getSnapshot()).toBe(stopped)
  })
})
