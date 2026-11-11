import { afterEach, describe, expect, test } from 'bun:test'
import {
  type DevicesResponse,
  fingerprintKey,
  type LinkedAccount,
  type RemoteAccessStatus,
  type RemoteSession,
  routes,
} from '@orch/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { connect } from '../lib/store'
import type { HostTransport } from '../transport'
import { RemoteAccessSetting } from './RemoteAccessSetting'

let disconnect = () => {}
afterEach(() => disconnect())

const key = `oek_${'k'.repeat(43)}`
const account = { name: 'Ada Lovelace', maskedEmail: 'a***@example.com' }

const linkedAccount: LinkedAccount = {
  ...account,
  serverUrl: 'wss://relay.example.com',
  linkedAt: '2026-11-04T12:00:00.000Z',
}
const deviceA = { id: 'a'.repeat(43), fingerprint: 'AAAA-AAAA-AAAA-AAAA' }
const deviceB = { id: 'b'.repeat(43), fingerprint: 'BBBB-BBBB-BBBB-BBBB' }
const deviceC = { id: 'c'.repeat(43), fingerprint: 'CCCC-CCCC-CCCC-CCCC' }

const notWaiting = (typed: string) =>
  `No browser with the fingerprint ${typed} is waiting. Open this machine in your own browser and type the fingerprint it shows.`

/**
 * Renders the dialog against a fake host that answers the link and device endpoints and records what it was sent.
 * `linked` starts it linked, with two browsers waiting and one approved.
 */
function setup({ linked = false } = {}) {
  const seenAt = '2026-11-04T12:05:00.000Z'
  let devices: DevicesResponse = {
    pending: [
      { ...deviceA, firstSeenAt: seenAt },
      { ...deviceB, firstSeenAt: seenAt },
    ],
    approved: [{ ...deviceC, approvedAt: seenAt }],
  }
  let status: RemoteAccessStatus = {
    enabled: true,
    serverUrl: 'wss://relay.example.com',
    serverUrlIsDefault: false,
    clientUrl: null,
    serverUrlFromEnv: false,
    clientUrlFromEnv: false,
    machineId: 'm-1',
    tunnel: 'connected',
    linkedAccount: linked ? linkedAccount : null,
  }
  // The fake host's open sessions; a test sets them to stand for browsers connecting.
  const live = { sessions: [] as RemoteSession[] }
  const sent: [string, unknown][] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      if (path === routes.remoteAccess.status.path) return Response.json(status)
      if (path === routes.remoteAccess.devices.path) return Response.json(devices)
      if (path === routes.remoteAccess.sessions.path) return Response.json(live)
      const body: unknown = JSON.parse(String(init.body))
      sent.push([path, body])
      if (path === routes.remoteAccess.previewLink.path) {
        if ((body as { key: string }).key !== key)
          return new Response('This key is unknown, used or expired', { status: 400 })
        return Response.json({
          serverUrl: status.serverUrl,
          serverUrlIsDefault: false,
          account,
          fingerprint: 'kkkk',
          expiresAt: '2026-11-04T12:15:00.000Z',
        })
      }
      if (path === routes.remoteAccess.link.path) {
        status = { ...status, linkedAccount }
        return Response.json(status)
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
        live.sessions = live.sessions.filter((session) => session.deviceId !== id)
        devices = {
          pending: devices.pending.filter((d) => d.id !== id),
          approved: devices.approved.filter((d) => d.id !== id),
        }
        return Response.json(devices)
      }
      if (path === routes.remoteAccess.endSession.path) {
        const { id } = body as { id: string }
        live.sessions = live.sessions.filter((session) => session.deviceId !== id)
        return Response.json(live)
      }
      if (path === routes.remoteAccess.unlink.path) {
        status = { ...status, linkedAccount: null }
        return Response.json(status)
      }
      throw new Error(`Unexpected request: ${path}`)
    },
    openSocket: () => ({ close: () => {} }) as unknown as WebSocket,
  }
  disconnect = connect(transport)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RemoteAccessSetting />
    </QueryClientProvider>,
  )
  return { sent, queryClient, live }
}

describe('RemoteAccessSetting', () => {
  test('previews a key, sends link only on Link, keeps the key out of the caches, and unlinks', async () => {
    const user = userEvent.setup()
    const { sent, queryClient } = setup()
    const field = await screen.findByRole('textbox', { name: 'Link key' })

    await user.type(field, 'oek_wrong')
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('This key is unknown, used or expired')).toBeInTheDocument()

    await user.clear(field)
    await user.type(field, key)
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('region', { name: 'Check before linking' })).toHaveTextContent('Ada Lovelace')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('textbox', { name: 'Link key' })).toHaveValue('')

    await user.type(screen.getByRole('textbox', { name: 'Link key' }), key)
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await user.click(await screen.findByRole('button', { name: 'Link' }))
    expect(await screen.findByRole('region', { name: 'Linked account' })).toHaveTextContent('Linked to Ada Lovelace')
    expect(sent.map(([path]) => path)).toEqual([
      routes.remoteAccess.previewLink.path,
      routes.remoteAccess.previewLink.path,
      routes.remoteAccess.previewLink.path,
      routes.remoteAccess.link.path,
    ])
    expect(sent[3]?.[1]).toEqual({ key, serverUrl: 'wss://relay.example.com' })
    const cached = [...queryClient.getQueryCache().getAll(), ...queryClient.getMutationCache().getAll()]
    expect(JSON.stringify(cached.map((entry) => [entry.options, entry.state]))).not.toContain(key)

    await user.click(screen.getByRole('button', { name: 'Unlink' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Link key' })).toHaveValue(''))
    expect(sent.at(-1)).toEqual([routes.remoteAccess.unlink.path, {}])
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

  test('Sessions picks up a connected browser within a poll, End closes it, and Revoke drops its session', async () => {
    const user = userEvent.setup()
    const { sent, live } = setup({ linked: true })
    const section = await screen.findByRole('region', { name: 'Sessions' })
    expect(section).toHaveTextContent('No browser is connected through the tunnel.')

    const session = (device: typeof deviceA): RemoteSession => ({
      deviceId: device.id,
      fingerprint: device.fingerprint,
      credentials: [{ kind: 'account' }],
      sockets: 2,
      startedAt: '2026-11-04T12:10:00.000Z',
    })
    live.sessions = [session(deviceA), session(deviceC)]
    const end = await screen.findByRole('button', { name: `End ${deviceA.fingerprint}` }, { timeout: 3000 })
    expect(section).toHaveTextContent('Account · 2 sockets')

    await user.click(end)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `End ${deviceA.fingerprint}` })).not.toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: `Revoke ${deviceC.fingerprint}` }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `End ${deviceC.fingerprint}` })).not.toBeInTheDocument(),
    )
    expect(sent).toEqual([
      [routes.remoteAccess.endSession.path, { id: deviceA.id }],
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
