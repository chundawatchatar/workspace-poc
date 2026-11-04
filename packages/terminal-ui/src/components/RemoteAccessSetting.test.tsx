import { afterEach, describe, expect, test } from 'bun:test'
import { type DevicesResponse, type LinkedAccount, type RemoteAccessStatus, routes } from '@orch/shared'
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
  const sent: [string, unknown][] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      if (path === routes.remoteAccess.status.path) return Response.json(status)
      if (path === routes.remoteAccess.devices.path) return Response.json(devices)
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
        const { id } = body as { id: string }
        const device = devices.pending.find((d) => d.id === id)
        if (!device) return new Response('No browser with this id is waiting', { status: 404 })
        devices = {
          pending: devices.pending.filter((d) => d.id !== id),
          approved: [{ id, fingerprint: device.fingerprint, approvedAt: seenAt }, ...devices.approved],
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
  return { sent, queryClient }
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
  test('lists waiting and approved browsers by fingerprint, and Approve, Dismiss and Revoke update the list', async () => {
    const user = userEvent.setup()
    const { sent } = setup({ linked: true })
    const waiting = await screen.findByRole('list', { name: 'Waiting for approval' })
    expect(waiting).toHaveTextContent(deviceA.fingerprint)
    expect(waiting).toHaveTextContent(deviceB.fingerprint)
    expect(screen.getByRole('region', { name: 'Devices' })).toHaveTextContent(
      'Approve only a fingerprint shown in your own browser',
    )
    expect(screen.getByRole('list', { name: 'Approved' })).toHaveTextContent(deviceC.fingerprint)

    await user.click(screen.getByRole('button', { name: `Approve ${deviceA.fingerprint}` }))
    expect(await screen.findByRole('button', { name: `Revoke ${deviceA.fingerprint}` })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `Dismiss ${deviceB.fingerprint}` }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Waiting for approval' })).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: `Revoke ${deviceC.fingerprint}` }))
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Approved' })).not.toHaveTextContent(deviceC.fingerprint),
    )

    expect(sent).toEqual([
      [routes.remoteAccess.approveDevice.path, { id: deviceA.id }],
      [routes.remoteAccess.removeDevice.path, { id: deviceB.id }],
      [routes.remoteAccess.removeDevice.path, { id: deviceC.id }],
    ])
  })
})
