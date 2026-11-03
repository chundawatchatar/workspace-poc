import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { makePane, makeSurface, makeWorkspace, routes, type ServerEvent, type SessionInfo } from '@orch/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { connect, getSnapshot, setOverlay, useApp } from '../lib/store'
import { NavigationProvider } from '../navigation'
import { PageOptionsProvider } from '../pageOptions'
import type { HostTransport } from '../transport'
import { pendingAttention, Sidebar } from './Sidebar'

let disconnect = () => {}
afterEach(() => {
  mock.restore()
  disconnect()
  setOverlay(null)
  localStorage.clear()
  document.documentElement.style.removeProperty('--sidebar-width')
})

function setup() {
  const terminal = makeSurface('terminal')
  const shell = makeSurface('terminal')
  const exited = makeSurface('terminal')
  const main = makeWorkspace('main', '/home/me/repo', makePane([terminal, shell, exited, makeSurface('pulls')]))
  const other = makeWorkspace('other', '/other')
  const session: SessionInfo = {
    id: terminal.id,
    title: 'Claude',
    alive: true,
    attention: { at: 10, message: 'Review the change' },
    process: { pid: 1, name: 'claude', command: 'claude', startedAt: Date.now() - 65_000 },
    cwd: '/home/me/repo/src',
    progress: null,
    agent: { kind: 'claude', sessionId: null, cwd: '/home/me/repo' },
    interrupted: null,
    agentState: { state: 'waiting', reason: 'question', source: 'hooks', since: 1 },
    agentTracking: true,
  }
  const socket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket
  const transport: HostTransport = {
    request: async (path) => {
      if (!path.startsWith(routes.git.status.path)) throw new Error(`Unexpected request: ${path}`)
      return Response.json({ branch: 'feature', changes: 2 })
    },
    openSocket: () => socket,
  }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [main, other] },
    sessions: [
      session,
      { ...session, id: shell.id, process: null, agent: null, agentState: null, attention: null },
      { ...session, id: exited.id, alive: false, process: null, agent: null, agentState: null, attention: null },
    ],
    info: { home: '/home/me', shell: '/bin/zsh', platform: 'darwin', projectRoot: '/home/me/repo' },
  }
  socket.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)
  const visited: { workspaceId?: string }[] = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NavigationProvider
        value={{ workspaceId: main.id, navigate: (target) => visited.push(target), workspaceHref: (id) => `/w/${id}` }}
      >
        <PageOptionsProvider
          value={{
            machine: { id: 'm1', name: 'My machine' },
            header: <p>Account</p>,
            offlineHint: null,
            deniedHint: null,
            titleSuffix: 'Workspaces',
            remoteAccessSetting: false,
          }}
        >
          <StoreSidebar activeId={main.id} />
        </PageOptionsProvider>
      </NavigationProvider>
    </QueryClientProvider>,
  )
  return { ...view, main, other, terminal, session, visited, queryClient }
}

function StoreSidebar({ activeId }: { activeId: string }) {
  useApp((s) => s.state)
  return <Sidebar activeId={activeId} open />
}

describe('Sidebar', () => {
  test('remembers collapsed terminals and opens the selected terminal', async () => {
    const user = userEvent.setup()
    const { main, terminal, visited, unmount } = setup()
    const row = screen.getByRole('link', { name: /main/ })
    await user.click(within(row).getByRole('button', { name: /claude/ }))
    expect(visited).toEqual([{ workspaceId: main.id }])
    const root = getSnapshot().state?.workspaces[0].root
    expect(root?.type === 'pane' && root.activeSurfaceId).toBe(terminal.id)
    await user.click(screen.getByRole('button', { name: 'Hide terminals of main' }))
    expect(within(row).queryByRole('button', { name: /claude/ })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('poc-sidebar-collapsed') ?? '[]')).toEqual([main.id])
    await user.click(screen.getByRole('button', { name: 'Show terminals of main' }))
    expect(within(row).getByRole('button', { name: /claude/ })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('poc-sidebar-collapsed') ?? '[]')).toEqual([])
    await user.click(row)
    expect(visited).toEqual([{ workspaceId: main.id }, { workspaceId: main.id }])
    unmount()
  })

  test('renames a workspace and only closes it after confirmation, navigating to the remaining workspace', async () => {
    const user = userEvent.setup()
    const { main, other, visited } = setup()
    await user.dblClick(screen.getByText('main'))
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '  renamed  {Enter}')
    expect(screen.getByText('renamed')).toBeInTheDocument()
    expect(getSnapshot().state?.workspaces[0].name).toBe('renamed')
    await user.dblClick(screen.getByText('renamed'))
    await user.clear(screen.getByRole('textbox'))
    await user.keyboard('{Escape}')
    expect(screen.getByText('renamed')).toBeInTheDocument()
    visited.length = 0
    const confirm = spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Close workspace renamed' }))
    expect(getSnapshot().state?.workspaces.map((w) => w.id)).toEqual([main.id, other.id])
    expect(visited).toEqual([])
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Close workspace renamed' }))
    expect(getSnapshot().state?.workspaces.map((w) => w.id)).toEqual([other.id])
    expect(visited).toEqual([{ workspaceId: other.id }])
  })

  test.each([
    ['New workspace', 'new-workspace'],
    ['Keyboard shortcuts', 'help'],
    ['Choose theme', 'themes'],
  ] as const)('the %s button opens its overlay', async (name, overlay) => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name }))
    expect(getSnapshot().overlay).toBe(overlay)
  })

  test('the theme button switches between dark and light', async () => {
    const user = userEvent.setup()
    setup()
    const theme = getSnapshot().theme
    const other = theme === 'dark' ? 'light' : 'dark'
    await user.click(screen.getByRole('button', { name: `Switch to ${other} theme` }))
    expect(getSnapshot().theme).toBe(other)
    await user.click(screen.getByRole('button', { name: `Switch to ${theme} theme` }))
    expect(getSnapshot().theme).toBe(theme)
  })

  test('resizes the sidebar with the arrow keys, clamps it, and resets it on double-click', async () => {
    const user = userEvent.setup()
    setup()
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    handle.focus()
    await user.keyboard('{ArrowRight}')
    expect(handle).toHaveAttribute('aria-valuenow', '256')
    expect(localStorage.getItem('poc-sidebar-width')).toBe('256')
    await user.keyboard('{ArrowLeft}')
    expect(handle).toHaveAttribute('aria-valuenow', '240')
    await user.keyboard('{ArrowRight>20/}')
    expect(handle).toHaveAttribute('aria-valuenow', '480')
    await user.dblClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '240')
  })
})

describe('pendingAttention', () => {
  test("lists the workspace's terminals that need attention, newest first", () => {
    const terminal = makeSurface('terminal')
    const second = makeSurface('terminal')
    const workspace = makeWorkspace('main', '/repo', makePane([terminal, second]))
    const sessions = Object.fromEntries(
      [
        [terminal.id, 10],
        [second.id, 20],
        ['elsewhere', 30],
      ].map(([id, at]) => [id, { id, attention: { at, message: 'Attention' } } as SessionInfo]),
    )
    expect(pendingAttention(workspace, sessions).map((s) => s.id)).toEqual([second.id, terminal.id])
    expect(pendingAttention(workspace, {})).toEqual([])
  })
})
