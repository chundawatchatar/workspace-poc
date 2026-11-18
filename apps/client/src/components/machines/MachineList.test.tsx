import { afterEach, describe, expect, test } from 'bun:test'
import { type ConnectRequest, machineFingerprint, type ServerMachine, serverRoutes } from '@orch/shared'
import { Toaster } from '@orch/ui'
import { screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authSession, authUser } from '../../test/betterAuth'
import { server } from '../../test/msw'
import { renderWithProviders } from '../../test/render'
import { MachineList } from './MachineList'

const account = authUser({ id: 'u1', email: 'u1@example.com', name: 'U' })
const at = '2026-10-30T12:00:00.000Z'

function machine(id: string, name: string, state: Partial<ServerMachine> = {}): ServerMachine {
  return { machineId: id.repeat(43), name, createdAt: at, lastOpenedAt: at, online: true, remoteOff: false, ...state }
}

/**
 * Answers the session, the account's machines, `Desktop` and `Laptop` by default, none with a key in this browser,
 * and the waiting connect requests, none by default. Accepting one links its machine.
 */
function signedIn(machines = [machine('A', 'Desktop'), machine('B', 'Laptop')], requests: ConnectRequest[] = []) {
  const state = { machines, requests }
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json({ user: account, session: authSession('s1', account.id) }),
    ),
    http.get(`*${serverRoutes.machines.list.path}`, () => HttpResponse.json({ machines: state.machines })),
    http.get(`*${serverRoutes.machines.listRequests.path}`, () => HttpResponse.json({ requests: state.requests })),
    http.post(`*${serverRoutes.machines.acceptRequest.path}`, ({ params }) => {
      const found = state.requests.find((request) => request.id === params.id)
      if (!found) return HttpResponse.json({ error: { code: 'not_waiting', message: 'Not waiting.' } }, { status: 409 })
      state.requests = state.requests.filter((request) => request !== found)
      const linked = { ...machine('C', found.name), machineId: found.machineId }
      state.machines = [linked, ...state.machines]
      return HttpResponse.json(linked)
    }),
  )
}

afterEach(() => localStorage.clear())

describe('MachineList', () => {
  test('every listed machine name links to it, though this browser holds no key', async () => {
    signedIn()
    await renderWithProviders(<MachineList />)
    for (const [name, id] of [
      ['Desktop', 'A'],
      ['Laptop', 'B'],
    ] as const) {
      expect(await screen.findByRole('link', { name })).toHaveAttribute('href', `/m/${id.repeat(43)}`)
    }
    expect(screen.queryByText(/connect link/i)).not.toBeInTheDocument()
  })

  test('each row says Online, Offline or Remote access off', async () => {
    signedIn([
      machine('A', 'Desktop'),
      machine('B', 'Laptop', { online: false }),
      machine('C', 'Server', { online: false, remoteOff: true }),
    ])
    await renderWithProviders(<MachineList />)
    const row = async (name: string) => (await screen.findByText(name)).closest('li') as HTMLElement
    expect(await row('Desktop')).toHaveTextContent('Online')
    expect(await row('Laptop')).toHaveTextContent('Offline')
    expect(await row('Server')).toHaveTextContent('Remote access off')
    expect(await row('Server')).not.toHaveTextContent('Offline')
  })

  test('a waiting request shows above the machines with its fingerprint, and Accept links it', async () => {
    const machineId = 'D'.repeat(43)
    const id = '11111111-1111-4111-8111-111111111111'
    signedIn([machine('A', 'Desktop')], [{ id, machineId, name: 'Build box', requestedAt: at, expiresAt: at }])
    const { user } = await renderWithProviders(
      <>
        <MachineList />
        <Toaster />
      </>,
    )
    const waiting = await screen.findByRole('region', { name: 'Waiting to connect' })
    const row = within(waiting).getByRole('group', { name: 'Connect request from Build box' })
    expect(row).toHaveTextContent(`Machine key ${machineFingerprint(machineId)}`)
    expect(within(row).getByRole('button', { name: 'Reject Build box' })).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Accept Build box' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Build box is connected')
    expect(await screen.findByRole('link', { name: 'Build box' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Waiting to connect' })).not.toBeInTheDocument()
  })
})
