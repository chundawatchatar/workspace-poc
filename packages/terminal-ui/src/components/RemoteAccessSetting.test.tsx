import { afterEach, describe, expect, test } from 'bun:test'
import { type DevicesResponse, fingerprintKey, type LinkedAccount, type RemoteAccessStatus, routes } from '@orch/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { REMOVE_IN_CLIENT } from '../lib/remoteAccess'
import { connect } from '../lib/store'
import type { HostTransport } from '../transport'
import { RemoteAccessSetting } from './RemoteAccessSetting'

let disconnect = () => {}
afterEach(() => disconnect())

const key = `oek_${'k'.repeat(43)}`
const email = 'ada.lovelace@example.com'
const linkedAccount: LinkedAccount = {
  name: 'Ada Lovelace',
  maskedEmail: 'a***@example.com',
  serverUrl: 'wss://relay.example.com',
  linkedAt: '2026-11-04T12:00:00.000Z',
}
const deviceA = { id: 'a'.repeat(43), fingerprint: 'AAAA-AAAA-AAAA-AAAA' }
const deviceB = { id: 'b'.repeat(43), fingerprint: 'BBBB-BBBB-BBBB-BBBB' }
const deviceC = { id: 'c'.repeat(43), fingerprint: 'CCCC-CCCC-CCCC-CCCC' }

const notWaiting = (typed: string) =>
  `No browser with the fingerprint ${typed} is waiting. Open this machine in your own browser and type the fingerprint it shows.`

/**
 * Renders the dialog against a fake host that answers the connect and device endpoints and records what it was sent.
 * `linked` starts it linked, with two browsers waiting and one approved. `requested` lists every path it was asked for.
 */
function setup({ linked = false, address = {} as Partial<RemoteAccessStatus> } = {}) {
  const seenAt = '2026-11-04T12:05:00.000Z'
  let devices: DevicesResponse = {
    pending: [
      { ...deviceA, firstSeenAt: seenAt },
      { ...deviceB, firstSeenAt: seenAt },
    ],
    approved: [{ ...deviceC, approvedAt: seenAt }],
  }
  let status: RemoteAccessStatus = {
    serverUrl: 'wss://relay.example.com',
    serverUrlIsDefault: false,
    defaultServerUrl: 'wss://orch.example.com',
    clientUrl: null,
    serverUrlSetBy: null,
    clientUrlSetBy: null,
    machineId: 'm-1',
    machineFingerprint: 'ABCD-EFGH-JKMN-PQRS',
    tunnel: linked ? 'connected' : 'off',
    linkedAccount: linked ? linkedAccount : null,
    connectRequest: null,
    connectOutcome: null,
    ...address,
  }
  // The owner's answer in the client, which the dialog picks up from the status within a poll.
  const owner = {
    accept: () => {
      status = { ...status, linkedAccount, connectRequest: null }
    },
  }
  // Whether the fake server removes the machine on disconnect.
  const server = { removes: true }
  const reads: Record<string, () => Response> = {
    [routes.remoteAccess.status.path]: () => Response.json(status),
    [routes.remoteAccess.devices.path]: () => Response.json(devices),
  }
  const sent: [string, unknown][] = []
  const requested: string[] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      requested.push(path)
      const read = reads[path]
      if (read) return read()
      const body: unknown = JSON.parse(String(init.body))
      sent.push([path, body])
      if (path === routes.remoteAccess.connect.path) {
        const sent = body as { key: string; serverUrl: string }
        if (sent.key !== key) return new Response('This key is unknown, used or expired', { status: 400 })
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
        status = { ...status, serverUrl: sent.serverUrl, tunnel: 'connected', connectRequest: { expiresAt } }
        return Response.json(status)
      }
      if (path === routes.remoteAccess.cancelConnect.path) {
        const connectOutcome = {
          kind: 'cancelled' as const,
          message: 'The connect request was cancelled. Nothing was linked',
        }
        status = { ...status, tunnel: 'off', connectRequest: null, connectOutcome }
        return Response.json(status)
      }
      if (path === routes.remoteAccess.disconnect.path) {
        status = { ...status, tunnel: 'off', linkedAccount: null }
        devices = { pending: [], approved: [] }
        return Response.json({ status, removedFromAccount: server.removes })
      }
      if (path === routes.remoteAccess.approveDevice.path) {
        const { fingerprint } = body as { fingerprint: string }
        const device = devices.pending.find((d) => fingerprintKey(d.fingerprint) === fingerprintKey(fingerprint))
        if (!device) return new Response(notWaiting(fingerprint), { status: 404 })
        devices = {
          pending: devices.pending.filter((d) => d.id !== device.id),
          approved: [{ id: device.id, fingerprint: device.fingerprint, approvedAt: seenAt }, ...devices.approved],
        }
        return Response.json(devices)
      }
      if (path === routes.remoteAccess.removeDevice.path) {
        const { id } = body as { id: string }
        devices = {
          pending: devices.pending.filter((d) => d.id !== id),
          approved: devices.approved.filter((d) => d.id !== id),
        }
        return Response.json(devices)
      }
      throw new Error(`Unexpected request: ${path}`)
    },
    openSocket: () => ({ close: () => {} }) as unknown as WebSocket,
  }
  disconnect = connect(transport)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const open = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <RemoteAccessSetting />
      </QueryClientProvider>,
    )
  const dialog = { current: open() }
  /** Closes the dialog and opens it again, as the owner does. */
  const reopen = () => {
    dialog.current.unmount()
    dialog.current = open()
  }
  return { sent, requested, queryClient, server, owner, reopen }
}

describe('RemoteAccessSetting', () => {
  test('connects with the address in use after a confirm step, waits for the accept, keeps a refused attempt, and caches neither key nor email', async () => {
    const user = userEvent.setup()
    const { sent, requested, queryClient, owner, reopen } = setup()
    expect(await screen.findByText('Not connected')).toBeInTheDocument()
    const server = screen.getByRole('textbox', { name: 'Server address' })
    await waitFor(() => expect(server).toHaveValue('wss://relay.example.com'))
    await user.type(screen.getByRole('textbox', { name: 'Email' }), email)
    await user.type(screen.getByRole('textbox', { name: 'Key' }), 'oek_wrong')
    const connect = () => user.click(screen.getByRole('button', { name: 'Connect' }))
    const confirm = async () => {
      const check = await screen.findByRole('region', { name: 'Check before connecting' })
      await user.click(within(check).getByRole('button', { name: 'Connect' }))
    }
    await connect()
    await confirm()
    expect(await screen.findByText('This key is unknown, used or expired')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue(email)

    const keyField = screen.getByRole('textbox', { name: 'Key' })
    await user.clear(keyField)
    await user.type(keyField, key)
    await connect()
    await confirm()
    // The host holds the request for the owner, and the dialog shows it again after closing and reopening.
    const waiting = await screen.findByRole('region', { name: 'Waiting for approval' })
    expect(waiting).toHaveTextContent('check that it shows machine ABCD-EFGH-JKMN-PQRS')
    expect(screen.getByText('Waiting for approval…')).toBeInTheDocument()
    expect(screen.queryByText('This key is unknown, used or expired')).not.toBeInTheDocument()
    reopen()
    expect(await screen.findByRole('region', { name: 'Waiting for approval' })).toHaveTextContent('Time left')

    owner.accept()
    expect(await screen.findByRole('region', { name: 'Connected account' }, { timeout: 3000 })).toHaveTextContent(
      'Ada Lovelace',
    )
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(sent).toEqual([
      [routes.remoteAccess.connect.path, { email, key: 'oek_wrong', serverUrl: 'wss://relay.example.com' }],
      [routes.remoteAccess.connect.path, { email, key, serverUrl: 'wss://relay.example.com' }],
    ])
    const cached = [...queryClient.getQueryCache().getAll(), ...queryClient.getMutationCache().getAll()]
    const held = JSON.stringify(cached.map((entry) => [entry.options, entry.state]))
    for (const secret of [key, 'oek_wrong', email]) expect(held).not.toContain(secret)

    // Once connected, the key and the email are gone: after a disconnect the fields start empty again.
    const panel = screen.getByRole('region', { name: 'Connected account' })
    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByRole('textbox', { name: 'Email' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Key' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Server address' })).toHaveValue('wss://relay.example.com')

    // Sessions and Recent activity have their own dialog, so this one never asks for them.
    expect(screen.queryByRole('region', { name: 'Sessions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Recent activity' })).not.toBeInTheDocument()
    expect(requested).not.toContain(routes.remoteAccess.sessions.path)
    expect(requested).not.toContain(routes.remoteAccess.auditLog.path)
    // The host issues no access keys, so the dialog offers no connect link and never asks for one.
    expect(screen.queryByRole('button', { name: 'New connect link' })).not.toBeInTheDocument()
    expect(requested.filter((path) => path.startsWith('/api/access/'))).toEqual([])
  })

  test('Cancel ends a waiting request, and the form comes back with why it ended', async () => {
    const user = userEvent.setup()
    const { sent } = setup()
    await user.type(await screen.findByRole('textbox', { name: 'Email' }), email)
    await user.type(screen.getByRole('textbox', { name: 'Key' }), key)
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await user.click(
      within(await screen.findByRole('region', { name: 'Check before connecting' })).getByRole('button', {
        name: 'Connect',
      }),
    )
    const waiting = await screen.findByRole('region', { name: 'Waiting for approval' })
    await user.click(within(waiting).getByRole('button', { name: 'Cancel' }))

    const form = await screen.findByRole('form', { name: 'Connect to an account' })
    expect(form).toHaveTextContent('The connect request was cancelled. Nothing was linked')
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(sent.map(([path]) => path)).toEqual([
      routes.remoteAccess.connect.path,
      routes.remoteAccess.cancelConnect.path,
    ])
  })

  test("Disconnect asks first, and says to remove the machine in the client when the server didn't", async () => {
    const user = userEvent.setup()
    const { sent, server } = setup({ linked: true })
    server.removes = false
    const panel = await screen.findByRole('region', { name: 'Connected account' })
    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    expect(sent).toEqual([])
    await user.click(within(panel).getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText(REMOVE_IN_CLIENT)).toBeInTheDocument()
    expect(screen.getByText('Not connected')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Devices' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('')
    expect(sent).toEqual([[routes.remoteAccess.disconnect.path, {}]])
  })

  test('lists waiting and approved browsers by fingerprint, approves only a typed one, and Dismiss and Revoke update the list', async () => {
    const user = userEvent.setup()
    const { sent } = setup({ linked: true })
    const waiting = await screen.findByRole('list', { name: 'Waiting for approval' })
    expect(waiting).toHaveTextContent(deviceA.fingerprint)
    expect(waiting).toHaveTextContent(deviceB.fingerprint)
    expect(screen.getByRole('region', { name: 'Devices' })).toHaveTextContent(
      'Approve only a fingerprint shown in your own browser',
    )
    expect(screen.getByRole('list', { name: 'Approved' })).toHaveTextContent(deviceC.fingerprint)
    expect(screen.queryByRole('button', { name: `Approve ${deviceA.fingerprint}` })).not.toBeInTheDocument()

    const field = screen.getByRole('textbox', { name: 'Fingerprint shown in your browser' })
    await user.type(field, ' aaaaaaaa-aaaaaaaa {Enter}')
    expect(await screen.findByRole('button', { name: `Revoke ${deviceA.fingerprint}` })).toBeInTheDocument()
    await waitFor(() => expect(field).toHaveValue(''))
    await user.click(screen.getByRole('button', { name: `Dismiss ${deviceB.fingerprint}` }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Waiting for approval' })).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: `Revoke ${deviceC.fingerprint}` }))
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Approved' })).not.toHaveTextContent(deviceC.fingerprint),
    )

    expect(sent).toEqual([
      [routes.remoteAccess.approveDevice.path, { fingerprint: 'aaaaaaaa-aaaaaaaa' }],
      [routes.remoteAccess.removeDevice.path, { id: deviceB.id }],
      [routes.remoteAccess.removeDevice.path, { id: deviceC.id }],
    ])
  })

  test('a fingerprint no browser is waiting with shows the host message once and keeps the typed text', async () => {
    const user = userEvent.setup()
    const { sent } = setup({ linked: true })
    const field = await screen.findByRole('textbox', { name: 'Fingerprint shown in your browser' })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()

    await user.type(field, 'ZZZZ-ZZZZ')
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findAllByText(notWaiting('ZZZZ-ZZZZ'))).toHaveLength(1)
    expect(field).toHaveValue('ZZZZ-ZZZZ')
    expect(sent).toEqual([[routes.remoteAccess.approveDevice.path, { fingerprint: 'ZZZZ-ZZZZ' }]])
    expect(screen.getByRole('list', { name: 'Approved' })).not.toHaveTextContent(deviceA.fingerprint)
  })
})
