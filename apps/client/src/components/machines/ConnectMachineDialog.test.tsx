import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import { type CreateEnrollmentResponse, type ServerMachine, serverRoutes } from '@orch/shared'
import { Toaster } from '@orch/ui'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

/** A fake enrollment key with the contract's shape, ending in `tail` (4 characters), so its fingerprint is `tail`. */
function enrollment(tail: string, expiresAt: number): CreateEnrollmentResponse {
  return { key: `oek_${'k'.repeat(39)}${tail}`, fingerprint: tail, expiresAt: new Date(expiresAt).toISOString() }
}

/**
 * Answers the session, the account's machines (`state.machines`) and each create request with the next of `answers`
 * (an enrollment, or a status for a failure, 0 meaning a network error), and records the bodies of the creates.
 */
function fakeServer(answers: (CreateEnrollmentResponse | number)[]) {
  const state = { machines: [machine('A', 'Desktop')], creates: [] as string[] }
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json({ user: account, session: authSession('s1', account.id) }),
    ),
    http.get(`*${serverRoutes.machines.list.path}`, () => HttpResponse.json({ machines: state.machines })),
    http.post(`*${serverRoutes.machines.createEnrollment.path}`, async ({ request }) => {
      state.creates.push(await request.text())
      const answer = answers.shift()
      if (answer === undefined || typeof answer !== 'number') return HttpResponse.json(answer)
      if (answer === 0) return HttpResponse.error()
      return HttpResponse.json({ error: { code: 'internal', message: 'Failed.' } }, { status: answer })
    }),
  )
  return state
}

/**
 * The toast on screen. While the dialog is open, Base UI hides the rest of the page, the toaster included, from
 * screen readers, so the query has to look at hidden elements too.
 */
const findToast = () => screen.findByRole('alert', { hidden: true })

async function renderHome() {
  return renderWithProviders(
    <>
      <MachineList />
      <Toaster />
    </>,
  )
}

/** Lets pending requests and renders finish under fake timers: happy-dom's `fetch` and MSW wait on zero-delay timers. */
async function settle() {
  for (let i = 0; i < 50; i++) {
    await act(async () => {
      jest.advanceTimersByTime(0)
      await new Promise((resolve) => setImmediate(resolve))
    })
  }
}

afterEach(() => {
  jest.useRealTimers()
  mock.restore()
  // Removing the own property brings back happy-dom's clipboard.
  Reflect.deleteProperty(navigator, 'clipboard')
  localStorage.clear()
})

describe('ConnectMachineDialog', () => {
  test('shows a new key once, copies it and its command, and says when a new machine links', async () => {
    const first = enrollment('aaaa', Date.now() + 15 * 60_000)
    const second = enrollment('bbbb', Date.now() + 15 * 60_000)
    const state = fakeServer([first, second])
    const logged = [spyOn(console, 'log'), spyOn(console, 'info'), spyOn(console, 'debug')]
    const { user, queryClient, router } = await renderHome()

    await user.click(await screen.findByRole('button', { name: 'Connect a machine' }))
    const command = `bun run host:remote link ${first.key}`
    expect(await screen.findByText(command)).toBeInTheDocument()
    expect(screen.getByText(first.key)).toBeInTheDocument()
    expect(screen.getByText('aaaa')).toBeInTheDocument()
    expect(state.creates).toEqual(['{}'])

    await user.click(screen.getByRole('button', { name: 'Copy key' }))
    expect(await navigator.clipboard.readText()).toBe(first.key)
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(await navigator.clipboard.readText()).toBe(command)

    // A missing clipboard, as on an insecure origin, then one that refuses. The own property hides happy-dom's.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await user.click(screen.getByRole('button', { name: 'Copy key' }))
    expect(await findToast()).toHaveTextContent('Copying failed.')
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    })
    await user.click(screen.getByRole('button', { name: 'Copy command' }))
    expect(await findToast()).toHaveTextContent('Copying failed.')

    // Desktop was listed before the key was made, so only Laptop counts as the machine that used it. The dialog
    // reads the list every 2 seconds.
    state.machines = [machine('B', 'Laptop'), ...state.machines]
    expect(await screen.findByText('Laptop is linked', {}, { timeout: 3_000 })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('Laptop')).toBeInTheDocument()

    const held = JSON.stringify([
      document.body.innerHTML,
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.state.data]),
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
      { ...localStorage },
      window.location.href,
      router.state.location.href,
      logged.map((spy) => spy.mock.calls),
    ])
    expect(held).not.toContain(first.key)

    await user.click(screen.getByRole('button', { name: 'Connect a machine' }))
    expect(await screen.findByText(second.key)).toBeInTheDocument()
    expect(state.creates).toHaveLength(2)
  }, 10_000)

  test('counts down to the expiry, then hides the key and offers a new one', async () => {
    const start = new Date('2026-11-04T12:00:00.000Z').getTime()
    const first = enrollment('aaaa', start + 15 * 60_000)
    const renewed = enrollment('bbbb', start + 31 * 60_000)
    const state = fakeServer([first, renewed])
    await renderHome()
    const connect = await screen.findByRole('button', { name: 'Connect a machine' })
    jest.useFakeTimers({ now: start })
    const user = userEvent.setup({ advanceTimers: (ms) => jest.advanceTimersByTime(ms) })

    await user.click(connect)
    await settle()
    expect(screen.getByText(first.key)).toBeInTheDocument()
    expect(screen.getByText('15:00')).toBeInTheDocument()
    act(() => jest.advanceTimersByTime(1_000))
    expect(screen.getByText('14:59')).toBeInTheDocument()

    act(() => jest.advanceTimersByTime(14 * 60_000 + 59_000))
    expect(screen.queryByText(first.key)).not.toBeInTheDocument()
    expect(screen.queryByText(/host:remote/)).not.toBeInTheDocument()
    expect(screen.getByText(/expired/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create a new key' }))
    await settle()
    expect(state.creates).toHaveLength(2)
    expect(screen.getByText(renewed.key)).toBeInTheDocument()
    expect(screen.getByText('16:00')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await settle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  test('a failed create shows an error toast and Retry, and Retry asks again', async () => {
    const key = enrollment('cccc', Date.now() + 15 * 60_000)
    const state = fakeServer([503, 0, key])
    const { user } = await renderHome()

    await user.click(await screen.findByRole('button', { name: 'Connect a machine' }))
    expect(await findToast()).toHaveTextContent('Creating a key failed. Try again.')
    expect(screen.queryByText(/oek_/)).not.toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(state.creates).toHaveLength(2))
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(key.key)).toBeInTheDocument()
    expect(state.creates).toHaveLength(3)

    await user.click(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
