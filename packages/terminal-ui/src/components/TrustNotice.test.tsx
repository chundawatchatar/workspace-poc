import { afterEach, describe, expect, test } from 'bun:test'
import { type AgentTrackingStatus, makeWorkspace, routes, type ServerEvent, type SessionInfo } from '@orch/shared'
import { getToast } from '@orch/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { connect } from '../lib/store'
import type { HostTransport } from '../transport'
import { TrustNotice } from './TrustNotice'

let disconnect = () => {}
afterEach(() => disconnect())

function setup() {
  const workspace = makeWorkspace('main', '/repo')
  const session: SessionInfo = {
    id: 't1',
    title: 'Claude',
    alive: true,
    attention: null,
    process: null,
    cwd: '/repo',
    progress: null,
    agent: { kind: 'claude', sessionId: null, cwd: '/repo' },
    interrupted: null,
    agentState: null,
    agentTracking: true,
  }
  const socket = { close: () => {} } as unknown as WebSocket
  let status: AgentTrackingStatus = { claude: null, codex: null }
  const requests: unknown[] = []
  let respond: (response: Response) => void = () => {}
  const transport: HostTransport = {
    request: async (path, init) => {
      if (path === routes.agentTracking.status.path) return Response.json(status)
      if (path !== routes.agentTracking.update.path) throw new Error(`Unexpected request: ${path}`)
      requests.push(JSON.parse(String(init.body)))
      return new Promise<Response>((resolve) => {
        respond = resolve
      })
    },
    openSocket: () => socket,
  }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [workspace] },
    sessions: [session],
    info: { home: '/home', shell: 'zsh', platform: 'darwin', projectRoot: '/repo' },
  }
  socket.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TrustNotice sessionId="t1" />
      <TrustNotice sessionId="t1" />
    </QueryClientProvider>,
  )
  return {
    requests,
    fail: () => respond(new Response('unavailable', { status: 503 })),
    accept: (answer: 'on' | 'off') => {
      status = { ...status, claude: answer }
      respond(Response.json(status))
    },
  }
}

describe('TrustNotice', () => {
  test.each([
    ['Track', 'on'],
    ['Not now', 'off'],
  ] as const)('%s saves the answer and dismisses every notice for that agent', async (label, answer) => {
    const user = userEvent.setup()
    const host = setup()
    await screen.findAllByRole('region', { name: "Track Claude Code's status with hooks?" })
    await user.click(screen.getAllByRole('button', { name: label })[0])
    await waitFor(() => expect(host.requests).toEqual([{ agent: 'claude', answer }]))
    host.accept(answer)
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  })

  test('a failed answer shows an error, keeps the question, and allows retrying', async () => {
    const user = userEvent.setup()
    const host = setup()
    await screen.findAllByRole('button', { name: 'Track' })
    await user.click(screen.getAllByRole('button', { name: 'Track' })[0])
    await waitFor(() => expect(host.requests).toEqual([{ agent: 'claude', answer: 'on' }]))
    host.fail()
    await waitFor(() => expect(getToast()).toMatchObject({ message: 'Could not save the answer', kind: 'error' }))
    expect(screen.getAllByRole('region')).toHaveLength(2)
    await user.click(screen.getAllByRole('button', { name: 'Track' })[0])
    await waitFor(() => expect(host.requests).toHaveLength(2))
    host.accept('on')
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument())
  })
})
