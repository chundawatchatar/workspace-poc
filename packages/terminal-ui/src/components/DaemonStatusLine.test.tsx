import { afterEach, expect, test } from 'bun:test'
import { type DaemonReport, routes } from '@orch/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { connect } from '../lib/store'
import type { HostTransport } from '../transport'
import { DaemonStatusLine } from './Overlays'

let disconnect = () => {}
afterEach(() => disconnect())

/** Renders the line against a fake host that answers `/api/daemon` with `report`. */
function renderWith(report: DaemonReport) {
  const transport: HostTransport = {
    request: async (path) => {
      if (path === routes.system.daemon.path) return Response.json(report)
      throw new Error(`Unexpected request: ${path}`)
    },
    openSocket: () => ({ close: () => {} }) as unknown as WebSocket,
  }
  disconnect = connect(transport)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <DaemonStatusLine />
    </QueryClientProvider>,
  )
}

const report: DaemonReport = {
  uptimeMs: 90_000,
  liveTerminals: 2,
  compatibility: 'outdated',
  daemonProtocol: 1,
  stopCommand: 'bun run terminals:stop',
}

test('an out-of-date daemon shows its uptime and the command that replaces it', async () => {
  renderWith(report)
  const line = await screen.findByText(/out of date/)
  expect(line).toHaveTextContent('Terminal daemon: up 1m, out of date · 2 live terminals')
  expect(line).toHaveTextContent('run bun run terminals:stop to replace it (ends its shells)')
})

test('an incompatible daemon names its protocol and the command that replaces it', async () => {
  renderWith({ ...report, uptimeMs: null, liveTerminals: 0, compatibility: 'incompatible', daemonProtocol: 2 })
  const line = await screen.findByText(/incompatible/)
  expect(line).toHaveTextContent('Terminal daemon: incompatible (protocol 2) · 0 live terminals')
  expect(within(line).getByText('bun run terminals:stop').tagName).toBe('CODE')
})
