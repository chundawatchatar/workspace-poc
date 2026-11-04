import { afterEach, describe, expect, test } from 'bun:test'
import { type LinkedAccount, type RemoteAccessStatus, routes } from '@orch/shared'
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

/** Renders the dialog against a fake host that answers the link endpoints and records what it was sent. */
function setup() {
  let status: RemoteAccessStatus = {
    enabled: true,
    serverUrl: 'wss://relay.example.com',
    serverUrlIsDefault: false,
    clientUrl: null,
    serverUrlFromEnv: false,
    clientUrlFromEnv: false,
    machineId: 'm-1',
    tunnel: 'connected',
    linkedAccount: null,
  }
  const sent: [string, unknown][] = []
  const transport: HostTransport = {
    request: async (path, init) => {
      if (path === routes.remoteAccess.status.path) return Response.json(status)
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
        const linkedAccount: LinkedAccount = {
          ...account,
          serverUrl: status.serverUrl,
          linkedAt: '2026-11-04T12:00:00.000Z',
        }
        status = { ...status, linkedAccount }
        return Response.json(status)
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
})
