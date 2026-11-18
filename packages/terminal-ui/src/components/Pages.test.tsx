import { afterEach, describe, expect, test } from 'bun:test'
import { type DevicesResponse, makePane, makeSurface, makeWorkspace, routes, type ServerEvent } from '@orch/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { apiKey } from '../lib/api'
import { askedAtLabel } from '../lib/pendingDevices'
import { connect, getSnapshot, setOverlay } from '../lib/store'
import { NavigationProvider } from '../navigation'
import { PageOptionsProvider } from '../pageOptions'
import type { HostTransport } from '../transport'
import { TransportProvider } from '../transportContext'
import { WorkspaceView } from './Pages'

let disconnect = () => {}
afterEach(() => {
  // The page may still be mounted here, so its store updates go through act.
  act(() => {
    disconnect()
    setOverlay(null)
  })
})

const waiting = {
  id: 'a'.repeat(43),
  fingerprint: 'AAAA-BBBB-CCCC-DDDD',
  firstSeenAt: '2026-11-04T12:05:00.000Z',
}

/**
 * Renders a workspace page whose host has one browser waiting for approval and no agent asking for attention.
 * Returns the paths it requested and a setter for the host's devices answer.
 */
function setup({ remoteAccessSetting }: { remoteAccessSetting: boolean }) {
  const workspace = makeWorkspace('main', '/home/me/repo', makePane([makeSurface('pulls')]))
  let devices: DevicesResponse = { pending: [waiting], approved: [] }
  const requested: string[] = []
  const socket = { readyState: 1, send: () => {}, close: () => {} } as unknown as WebSocket
  const transport: HostTransport = {
    request: async (path) => {
      requested.push(path)
      if (path === routes.remoteAccess.devices.path) return Response.json(devices)
      throw new Error(`Unexpected request: ${path}`)
    },
    openSocket: () => socket,
  }
  disconnect = connect(transport)
  const hello: ServerEvent = {
    type: 'hello',
    clientId: 'c1',
    state: { rev: 1, workspaces: [workspace] },
    sessions: [],
    info: { home: '/home/me', shell: '/bin/zsh', platform: 'darwin', projectRoot: '/home/me/repo' },
  }
  socket.onmessage?.({ data: JSON.stringify(hello) } as MessageEvent)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider value={transport}>
        <NavigationProvider
          value={{ workspaceId: workspace.id, navigate: () => {}, workspaceHref: (id) => `/w/${id}` }}
        >
          <PageOptionsProvider
            value={{
              machine: undefined,
              header: null,
              footer: null,
              offlineHint: null,
              deniedHint: null,
              unapprovedHint: null,
              titleSuffix: 'Workspaces',
              remoteAccessSetting,
              remoteAccessStatus: false,
            }}
          >
            <WorkspaceView workspaceId={workspace.id} />
          </PageOptionsProvider>
        </NavigationProvider>
      </TransportProvider>
    </QueryClientProvider>,
  )
  /** Answers the next poll with `next`, and runs it now instead of waiting for the interval. */
  const poll = async (next: DevicesResponse) => {
    devices = next
    await queryClient.refetchQueries({ queryKey: apiKey(routes.remoteAccess.devices, {}) })
  }
  return { requested, poll }
}

describe('Notifications', () => {
  test('a waiting browser counts in the bell, shows its fingerprint and time, and opens Remote access', async () => {
    const user = userEvent.setup()
    const { poll } = setup({ remoteAccessSetting: true })
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' })

    await user.click(bell)
    const item = screen.getByRole('button', { name: /A browser asks for approval/ })
    expect(item).toHaveTextContent(
      `A browser asks for approval${waiting.fingerprint} · ${askedAtLabel(waiting.firstSeenAt)}`,
    )
    expect(item).not.toHaveTextContent(waiting.id)

    await user.click(item)
    expect(getSnapshot().overlay).toBe('remote-access')
    expect(screen.queryByRole('button', { name: /A browser asks for approval/ })).not.toBeInTheDocument()

    await poll({
      pending: [],
      approved: [{ id: waiting.id, fingerprint: waiting.fingerprint, approvedAt: waiting.firstSeenAt }],
    })
    expect(await screen.findByRole('button', { name: 'Notifications, 0 unread' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Notifications, 0 unread' }))
    expect(screen.getByText('Nothing needs your attention.')).toBeInTheDocument()
  })

  test('a page without the Remote access setting never asks the host for devices', async () => {
    const user = userEvent.setup()
    const { requested } = setup({ remoteAccessSetting: false })
    await user.click(await screen.findByRole('button', { name: 'Notifications, 0 unread' }))
    expect(within(document.body).queryByText('A browser asks for approval')).not.toBeInTheDocument()
    expect(requested).not.toContain(routes.remoteAccess.devices.path)
  })
})
