import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test'
import {
  type ConnectRequest,
  type CreateEnrollmentResponse,
  machineFingerprint,
  type ServerMachine,
  serverRoutes,
} from '@orch/shared'
import { Toaster } from '@orch/ui'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { authSession, authUser } from '../../test/betterAuth'
import { server } from '../../test/msw'
import { renderWithProviders } from '../../test/render'
import { MachineList } from './MachineList'

const account = authUser({ id: 'u1', email: 'u1@example.com', name: 'U' })
const serverUrl = 'wss://relay.example.com'
const at = '2026-10-30T12:00:00.000Z'

function machine(id: string, name: string): ServerMachine {
  return { machineId: id.repeat(43), name, createdAt: at, lastOpenedAt: at, online: true, remoteOff: false }
}

/**
 * A fake enrollment key with the contract's shape, ending in `tail` (4 characters), so its fingerprint is `tail`. Its
 * id is a fixed UUID made of `tail`'s first character, which must be a hex digit.
 */
function enrollment(tail: string, expiresAt: number): CreateEnrollmentResponse {
  const key = `oek_${'k'.repeat(39)}${tail}`
  const id = `${tail[0]?.repeat(8)}-0000-4000-8000-000000000000`
  return { id, key, fingerprint: tail, expiresAt: new Date(expiresAt).toISOString(), serverUrl }
}

/** The connect request a machine makes with `key`: the machine `machineId` asks as `name`. */
function requestWith(key: CreateEnrollmentResponse, machineId: string, name: string): ConnectRequest {
  return { id: key.id, machineId, name, requestedAt: at, expiresAt: key.expiresAt }
}

/**
 * Answers the session, the account's machines (`state.machines`), the waiting requests (`state.requests`) and each
 * create request with the next of `answers` (an enrollment, or a status for a failure, 0 meaning a network error),
 * and records the bodies of the creates. Accept links a waiting request's machine, and reject drops it, unless
 * `state.stopped` says the machine stopped waiting.
 */
function fakeServer(answers: (CreateEnrollmentResponse | number)[]) {
  const state = {
    machines: [machine('A', 'Desktop')],
    requests: [] as ConnectRequest[],
    creates: [] as string[],
    stopped: false,
  }
  /** Takes the waiting request the path names, or answers why not. */
  const take = (id: unknown) => {
    const found = state.requests.find((request) => request.id === id)
    state.requests = state.requests.filter((request) => request !== found)
    if (!found) return HttpResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
    if (state.stopped) {
      return HttpResponse.json({ error: { code: 'not_waiting', message: 'Not waiting.' } }, { status: 409 })
    }
    return found
  }
  server.use(
    http.get('*/api/auth/get-session', () =>
      HttpResponse.json({ user: account, session: authSession('s1', account.id) }),
    ),
    http.get(`*${serverRoutes.machines.list.path}`, () => HttpResponse.json({ machines: state.machines })),
    http.get(`*${serverRoutes.machines.listRequests.path}`, () => HttpResponse.json({ requests: state.requests })),
    http.post(`*${serverRoutes.machines.acceptRequest.path}`, ({ params }) => {
      const taken = take(params.id)
      if (taken instanceof Response) return taken
      const linked = { ...machine('A', taken.name), machineId: taken.machineId }
      state.machines = [linked, ...state.machines]
      return HttpResponse.json(linked)
    }),
    http.post(`*${serverRoutes.machines.rejectRequest.path}`, ({ params }) => {
      const taken = take(params.id)
      return taken instanceof Response ? taken : HttpResponse.json({ ok: true })
    }),
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
  test('shows a new key once, copies it and its corch connect command, and accepts the machine that asks with it', async () => {
    const first = enrollment('aaaa', Date.now() + 15 * 60_000)
    const second = enrollment('bbbb', Date.now() + 15 * 60_000)
    const state = fakeServer([first, second])
    const logged = [spyOn(console, 'log'), spyOn(console, 'info'), spyOn(console, 'debug')]
    const { user, queryClient, router } = await renderHome()

    await user.click(await screen.findByRole('button', { name: 'Connect a machine' }))
    const command = `corch connect --email u1@example.com --key ${first.key} --server ${serverUrl}`
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

    // Another key's request waits too, but the dialog shows only the one made with its own key, read every 2 seconds.
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Waiting for the machine to connect…')).toBeInTheDocument()
    const other = enrollment('cccc', Date.now() + 15 * 60_000)
    const laptopId = 'B'.repeat(43)
    state.requests = [requestWith(other, 'C'.repeat(43), 'Server'), requestWith(first, laptopId, 'Laptop')]
    const row = await within(dialog).findByRole('group', { name: 'Connect request from Laptop' }, { timeout: 3_000 })
    expect(row).toHaveTextContent(`Machine key ${machineFingerprint(laptopId)}`)
    expect(within(dialog).queryByText('Server')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Waiting for the machine to connect…')).not.toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Accept Laptop' }))
    expect(await screen.findByText('Laptop is connected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The machine list was read again, so Laptop is listed at once.
    expect(screen.getByRole('link', { name: 'Open Laptop' })).toBeInTheDocument()

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
  }, 15_000)

  test('Reject says the machine was not connected, and a request that stopped waiting says so in a toast', async () => {
    const first = enrollment('aaaa', Date.now() + 15 * 60_000)
    const second = enrollment('bbbb', Date.now() + 15 * 60_000)
    const state = fakeServer([first, second])
    const { user } = await renderHome()
    await user.click(await screen.findByRole('button', { name: 'Connect a machine' }))
    expect(await screen.findByText(first.key)).toBeInTheDocument()
    state.requests = [requestWith(first, 'B'.repeat(43), 'Laptop')]
    await user.click(await screen.findByRole('button', { name: 'Reject Laptop' }, { timeout: 3_000 }))
    expect(await screen.findByText(/Laptop was not connected/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))

    await user.click(screen.getByRole('button', { name: 'Connect a machine' }))
    expect(await screen.findByText(second.key)).toBeInTheDocument()
    state.requests = [requestWith(second, 'C'.repeat(43), 'Server')]
    state.stopped = true
    await user.click(await screen.findByRole('button', { name: 'Accept Server' }, { timeout: 3_000 }))
    expect(await findToast()).toHaveTextContent('The machine stopped waiting. Nothing was linked.')
    // The requests are read again, so the row goes and the dialog waits again, with nothing linked.
    expect(await screen.findByText('Waiting for the machine to connect…')).toBeInTheDocument()
    expect(state.machines.map((m) => m.name)).toEqual(['Desktop'])
  }, 15_000)

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
    expect(screen.queryByText(/corch connect/)).not.toBeInTheDocument()
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
