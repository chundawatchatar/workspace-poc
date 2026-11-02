import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ClientEvent,
  listPanes,
  makePane,
  makeSurface,
  makeWorkspace,
  routes,
  type ServerEvent,
  type SessionInfo,
} from '@orch/shared'
import { Toaster } from '@orch/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { connect, getSnapshot, useApp } from '../lib/store'
import type { HostTransport } from '../transport'
import { TransportProvider } from '../transportContext'
import { LayoutView } from './LayoutView'

let disconnect = () => {}
afterEach(() => disconnect())

/**
 * Connects the store through a fake transport and says `hello` with one pane holding a terminal, whose shell reports
 * a folder and agent tracking, and a `pulls` tab. Returns what the page sent on the events socket.
 */
function setup() {
  const terminal = makeSurface('terminal')
  const pulls = makeSurface('pulls')
  const workspace = makeWorkspace('main', '/home/me/repo', makePane([terminal, pulls]))
  const session: SessionInfo = {
    id: terminal.id,
    title: 'me@box:/home/me/repo/src',
    alive: true,
    attention: null,
    process: null,
    cwd: '/home/me/repo/src',
    progress: null,
    agent: null,
    interrupted: null,
    agentState: null,
    agentTracking: true,
  }

  const sent: ClientEvent[] = []
  let events: WebSocket | undefined
  const transport: HostTransport = {
    request: async () => Response.json({}),
    // Terminal views open sockets of their own; only the events socket records what it is sent.
    openSocket: (path) => {
      const isEvents = path.startsWith(routes.sockets.events.path)
      const socket = {
        readyState: 1,
        send: (data: string) => isEvents && sent.push(JSON.parse(data)),
        close: () => {},
      } as unknown as WebSocket
      if (isEvents) events = socket
      return socket
    },
  }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [workspace] },
    sessions: [session],
    info: { home: '/home/me', shell: 'zsh', platform: 'darwin', projectRoot: '/home/me/repo' },
  }
  events?.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)

  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider value={transport}>
        <StoreLayout />
      </TransportProvider>
      <Toaster />
    </QueryClientProvider>,
  )
  return { sent, terminal }
}

/** The layout of the store's first workspace, as a page shows it. */
function StoreLayout() {
  const workspace = useApp((s) => s.state?.workspaces[0])
  return workspace ? <LayoutView workspace={workspace} /> : null
}

const surfaces = () => listPanes(getSnapshot().state?.workspaces[0].root ?? makePane()).flatMap((p) => p.surfaces)

describe('LayoutView tab bar', () => {
  test('"New tab" adds a terminal to the pane', async () => {
    const user = userEvent.setup()
    setup()
    expect(screen.queryAllByRole('button', { name: 'Close Terminal' })).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'New tab' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Terminal' }))

    expect(screen.getAllByRole('button', { name: 'Close Terminal' })).toHaveLength(1)
    expect(surfaces().map((s) => s.kind)).toEqual(['terminal', 'pulls', 'terminal'])
  })

  test("a terminal tab's menu copies its folder and stops tracking; other tabs keep the browser's menu", async () => {
    const user = userEvent.setup()
    const { sent, terminal } = setup()

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTitle('src') })
    expect(await screen.findByRole('menu', { name: 'src tab' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Copy working folder' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Copied ~/repo/src')
    expect(await navigator.clipboard.readText()).toBe('/home/me/repo/src')

    await user.pointer({ keys: '[MouseRight]', target: screen.getByTitle('src') })
    expect(await screen.findByRole('menu', { name: 'src tab' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Stop tracking the agent' }))
    expect(sent).toContainEqual({ type: 'agentTracking', sessionId: terminal.id, on: false })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

    const prevented: boolean[] = []
    const record = (event: Event) => prevented.push(event.defaultPrevented)
    document.addEventListener('contextmenu', record)
    try {
      await user.pointer({ keys: '[MouseRight]', target: screen.getByTitle('Pull requests') })
    } finally {
      document.removeEventListener('contextmenu', record)
    }
    expect(prevented).toEqual([false])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
