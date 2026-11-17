import { afterEach, describe, expect, test } from 'bun:test'
import { type AuditLogEntry, formatLocalDateTime, type RemoteSession, routes } from '@orch/shared'
import { Toaster } from '@orch/ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { connect, getSnapshot, setOverlay } from '../lib/store'
import type { HostTransport } from '../transport'
import { RemoteAccessActivityDialog } from './RemoteAccessActivityDialog'

let disconnect = () => {}
afterEach(() => {
  disconnect()
  setOverlay(null)
})

const deviceA = { id: 'a'.repeat(43), fingerprint: 'AAAA-AAAA-AAAA-AAAA' }
const deviceB = { id: 'b'.repeat(43), fingerprint: 'BBBB-BBBB-BBBB-BBBB' }
const deviceC = { id: 'c'.repeat(43), fingerprint: 'CCCC-CCCC-CCCC-CCCC' }

function session(device: typeof deviceA): RemoteSession {
  return {
    deviceId: device.id,
    fingerprint: device.fingerprint,
    credentials: [{ kind: 'account' }],
    sockets: 2,
    startedAt: '2026-11-04T12:10:00.000Z',
  }
}

/**
 * Opens the dialog against a fake host that records what it was sent.
 * `live.sessions` stands for the browsers connected now, and `audit.entries`
 * for its audit log; null makes that request fail. An End waits for
 * `endGate.open` when one is set, and `endFails` makes it fail.
 */
function setup({ auditLog = [] as AuditLogEntry[] | null } = {}) {
  const live = { sessions: [] as RemoteSession[] }
  const audit = { entries: auditLog }
  const endGate: { open: Promise<void> | null; endFails: boolean } = { open: null, endFails: false }
  const sent: [string, unknown][] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      if (path === routes.remoteAccess.sessions.path) return Response.json(live)
      if (path === routes.remoteAccess.auditLog.path) {
        return audit.entries ? Response.json(audit) : new Response('the host stopped', { status: 500 })
      }
      if (path === routes.remoteAccess.endSession.path) {
        const { id } = JSON.parse(String(init.body)) as { id: string }
        sent.push([path, { id }])
        if (endGate.open) await endGate.open
        if (endGate.endFails) return new Response('the host stopped', { status: 500 })
        live.sessions = live.sessions.filter((open) => open.deviceId !== id)
        return Response.json(live)
      }
      throw new Error(`Unexpected request: ${path}`)
    },
    openSocket: () => ({ close: () => {} }) as unknown as WebSocket,
  }
  disconnect = connect(transport)
  setOverlay('remote-access-activity')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RemoteAccessActivityDialog />
      <Toaster />
    </QueryClientProvider>,
  )
  return { sent, live, audit, endGate }
}

describe('RemoteAccessActivityDialog', () => {
  test('Sessions picks up a connected browser within a poll, End waits and closes it, a failed End is a toast, and Escape closes', async () => {
    const user = userEvent.setup()
    const { sent, live, endGate } = setup()
    const section = await screen.findByRole('region', { name: 'Sessions' })
    expect(await within(section).findByText('No browser is connected through the tunnel.')).toBeInTheDocument()

    live.sessions = [session(deviceA), session(deviceC)]
    const end = await screen.findByRole('button', { name: `End ${deviceA.fingerprint}` }, { timeout: 3000 })
    expect(section).toHaveTextContent('Account · 2 sockets')

    let release = () => {}
    endGate.open = new Promise((resolve) => {
      release = resolve
    })
    await user.click(end)
    await waitFor(() => expect(screen.getByRole('button', { name: `End ${deviceC.fingerprint}` })).toBeDisabled())
    await act(async () => release())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `End ${deviceA.fingerprint}` })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: `End ${deviceC.fingerprint}` })).toBeEnabled()

    endGate.open = null
    endGate.endFails = true
    await user.click(screen.getByRole('button', { name: `End ${deviceC.fingerprint}` }))
    // The open modal hides the rest of the page, the toaster included, from the accessibility tree.
    expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent('the host stopped')
    expect(screen.getByRole('button', { name: `End ${deviceC.fingerprint}` })).toBeInTheDocument()
    expect(sent).toEqual([
      [routes.remoteAccess.endSession.path, { id: deviceA.id }],
      [routes.remoteAccess.endSession.path, { id: deviceC.id }],
    ])

    await user.keyboard('{Escape}')
    expect(getSnapshot().overlay).toBeNull()
  })

  test('Recent activity says when it could not load, then shows sessions and refusals within a poll', async () => {
    const openedAt = '2026-11-04T12:00:00.000Z'
    const closedAt = '2026-11-04T12:30:00.000Z'
    const { audit } = setup({ auditLog: null })
    const section = await screen.findByRole('region', { name: 'Recent activity' })
    expect(await within(section).findByText("Couldn't load recent activity.")).toBeInTheDocument()
    audit.entries = [
      {
        kind: 'refused',
        reason: 'device_not_approved',
        at: closedAt,
        fingerprint: deviceA.fingerprint,
        principal: 'account',
      },
      {
        kind: 'session',
        session: 's2',
        principal: 'account',
        accountId: 'u1',
        fingerprint: deviceB.fingerprint,
        openedAt,
        closedAt: null,
      },
      {
        kind: 'session',
        session: 's1',
        principal: 'account',
        accountId: 'u1',
        fingerprint: deviceC.fingerprint,
        openedAt,
        closedAt,
      },
    ]
    const list = await within(section).findByRole('list', { name: 'Recent remote access' }, { timeout: 3000 })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      `Refused: browser not approved${formatLocalDateTime(closedAt)}${deviceA.fingerprint}`,
      `${deviceB.fingerprint}Through the accountOpened ${formatLocalDateTime(openedAt)}, still open or not recorded`,
      `${deviceC.fingerprint}Through the accountOpened ${formatLocalDateTime(openedAt)}, closed ${formatLocalDateTime(closedAt)}`,
    ])
  })
})
