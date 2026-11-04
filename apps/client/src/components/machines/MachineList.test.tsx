import { afterEach, describe, expect, test } from 'bun:test'
import { type ServerMachine, serverRoutes } from '@orch/shared'
import { screen } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authSession, authUser } from '../../test/betterAuth'
import { server } from '../../test/msw'
import { renderWithProviders } from '../../test/render'
import { MachineList } from './MachineList'

const account = authUser({ id: 'u1', email: 'u1@example.com', name: 'U' })
const at = '2026-10-30T12:00:00.000Z'

function machine(id: string, name: string): ServerMachine {
  return { machineId: id.repeat(43), name, createdAt: at, lastOpenedAt: at, online: true }
}

/** Answers the session and the account's machines, `Desktop` and `Laptop`, neither with a key in this browser. */
function signedIn() {
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json({ user: account, session: authSession('s1', account.id) }),
    ),
    http.get(`*${serverRoutes.machines.list.path}`, () =>
      HttpResponse.json({ machines: [machine('A', 'Desktop'), machine('B', 'Laptop')] }),
    ),
  )
}

afterEach(() => localStorage.clear())

describe('MachineList', () => {
  test('every listed machine has an Open link, though this browser holds no key', async () => {
    signedIn()
    await renderWithProviders(<MachineList />)
    for (const [name, id] of [
      ['Desktop', 'A'],
      ['Laptop', 'B'],
    ] as const) {
      expect(await screen.findByRole('link', { name: `Open ${name}` })).toHaveAttribute('href', `/m/${id.repeat(43)}`)
    }
    expect(screen.queryByText(/connect link/i)).not.toBeInTheDocument()
  })
})
