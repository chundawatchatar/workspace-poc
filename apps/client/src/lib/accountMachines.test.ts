import { afterEach, describe, expect, jest, test } from 'bun:test'
import { formatConnectFragment, type ServerMachine, serverRoutes } from '@orch/shared'
import { FormApi } from '@tanstack/react-form'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authSession, authUser } from '../test/betterAuth'
import { server } from '../test/msw'
import {
  machinesQuery,
  newMachine,
  relayTicketFor,
  renameMachineFormOptions,
  renameMachineMutation,
  unlinkMachineMutation,
} from './accountMachines'
import { accountKey, refetchSession, type SessionUser, watchIdentity } from './auth'
import { acceptConnectLink, type ConnectWindow, loadMachines, saveMachine } from './machines'

const userA: SessionUser = { id: 'user-a', email: 'a@example.com', name: 'Ada' }

// Machine ids have the relay's shape: 43 base64url characters.
const idOne = 'A'.repeat(43)
const idTwo = 'B'.repeat(43)
const accessKey = 'the-access-key-value'

function machine(machineId: string, name: string, online = false): ServerMachine {
  const at = '2026-10-30T12:00:00.000Z'
  return { machineId, name, createdAt: at, lastOpenedAt: at, online }
}

/** A server error answer, as `serverRoutes` endpoints send it. */
const serverError = (status: number, code: string) =>
  HttpResponse.json({ error: { code, message: 'Refused.' } }, { status })

/**
 * Answers the cloud server's session and machines endpoints for whoever the cookie belongs to (`state.user`): each
 * user's machines, whether writes fail, and every request.
 */
function fakeServer(user: SessionUser | null) {
  const state = {
    user,
    machines: {} as Record<string, ServerMachine[]>,
    failWrites: false,
    requests: [] as { method: string; path: string; body: string }[],
  }
  /** The signed-in user's machines, or null when the cookie holds no session. */
  const mine = () => {
    if (!state.user) return null
    state.machines[state.user.id] ??= []
    return state.machines[state.user.id] ?? []
  }
  /** The signed-in user's machine named in the request's path. */
  const target = (params: Record<string, unknown>) => mine()?.find((m) => m.machineId === params.machineId)
  const unauthorized = () => serverError(401, 'unauthorized')
  server.use(
    http.all('*', async ({ request }) => {
      const body = request.method === 'GET' ? '' : await request.clone().text()
      state.requests.push({ method: request.method, path: new URL(request.url).pathname, body })
    }),
    http.get('*/api/auth/get-session', () => {
      const current = state.user
      return HttpResponse.json(
        current && { user: authUser(current), session: authSession(`s-${current.id}`, current.id) },
      )
    }),
    http.get(`*${serverRoutes.machines.list.path}`, () => {
      const list = mine()
      return list ? HttpResponse.json({ machines: list }) : unauthorized()
    }),
    http.patch(`*${serverRoutes.machines.rename.path}`, async ({ request, params }) => {
      if (!mine()) return unauthorized()
      const found = target(params)
      if (!found) return serverError(404, 'not_found')
      if (state.failWrites) return serverError(500, 'internal')
      found.name = ((await request.json()) as { name: string }).name
      return HttpResponse.json(found)
    }),
    http.delete(`*${serverRoutes.machines.unlink.path}`, ({ params }) => {
      const current = state.user
      if (!current) return unauthorized()
      const found = target(params)
      if (!found) return serverError(404, 'not_found')
      if (state.failWrites) return serverError(500, 'internal')
      state.machines[current.id] = (mine() ?? []).filter((m) => m !== found)
      return HttpResponse.json({ ok: true })
    }),
  )
  return state
}

/** A query client with the identity watcher, as `getRouter()` builds it, signed in as `user`. */
async function setup(user: SessionUser | null) {
  const state = fakeServer(user)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  watchIdentity(queryClient, () => {})
  await refetchSession(queryClient)
  state.requests.length = 0
  return { queryClient, state }
}

/** Keeps the list on screen, as the home page does, so invalidating it reads it again. Returns how to stop. */
function watchList(queryClient: QueryClient, userId: string) {
  return new QueryObserver(queryClient, machinesQuery(userId)).subscribe(() => {})
}

/** Lets a pending request finish under fake timers: happy-dom's `fetch` and MSW wait on zero-delay timers. */
async function settle() {
  for (let i = 0; i < 50; i++) {
    jest.advanceTimersByTime(0)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** A window that has just opened a connect link for `machineId`. */
function connectWindow(machineId: string): ConnectWindow {
  const location = new URL(`https://app.test/${formatConnectFragment({ machineId, key: accessKey })}`)
  return { location, history: { state: null, replaceState: () => {} } }
}

afterEach(() => {
  jest.useRealTimers()
})

describe('the machine list', () => {
  test("is the account's machines in the server's order, keyed by the user, read again every 10 seconds", async () => {
    const { queryClient, state } = await setup(userA)
    state.machines[userA.id] = [machine(idTwo, 'Desktop', true), machine(idOne, 'Laptop')]
    saveMachine({ id: 'only-in-this-browser', name: 'Old', key: 'k' })
    expect([...machinesQuery(userA.id).queryKey]).toEqual([
      ...accountKey(userA.id, serverRoutes.machines.list.path, {}),
    ])

    jest.useFakeTimers()
    const stop = watchList(queryClient, userA.id)
    await settle()
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => [m.name, m.online])).toEqual(
      [
        ['Desktop', true],
        ['Laptop', false],
      ],
    )
    const lists = () => state.requests.filter((r) => r.path === serverRoutes.machines.list.path).length
    expect(lists()).toBe(1)
    jest.advanceTimersByTime(9_000)
    await settle()
    expect(lists()).toBe(1)
    jest.advanceTimersByTime(1_000)
    await settle()
    expect(lists()).toBe(2)
    stop()
  })

  test('rename and unlink change the list, unlink forgets the key, and a failure leaves it as it was', async () => {
    const { queryClient, state } = await setup(userA)
    state.machines[userA.id] = [machine(idOne, 'Laptop'), machine(idTwo, 'Desktop')]
    saveMachine({ id: idOne, name: 'Laptop', key: accessKey })
    const stop = watchList(queryClient, userA.id)
    const list = async () => (await queryClient.fetchQuery(machinesQuery(userA.id))).machines.map((m) => m.name)
    expect(await list()).toEqual(['Laptop', 'Desktop'])
    const rename = new MutationObserver(queryClient, renameMachineMutation(queryClient, userA.id))
    const unlink = new MutationObserver(queryClient, unlinkMachineMutation(queryClient, userA.id))

    // The rename form never sends a name the contract refuses.
    const form = new FormApi(renameMachineFormOptions('Laptop', (name) => rename.mutate({ machineId: idOne, name })))
    form.mount()
    for (const bad of ['   ', 'x'.repeat(65)]) {
      form.setFieldValue('name', bad)
      await form.handleSubmit()
    }
    expect(state.requests.filter((r) => r.method === 'PATCH')).toEqual([])
    form.setFieldValue('name', '  Work laptop ')
    await form.handleSubmit()
    await waitFor(() => expect(rename.getCurrentResult().isSuccess).toBe(true))
    expect(state.requests.find((r) => r.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `/api/machines/${idOne}`,
      body: JSON.stringify({ name: 'Work laptop' }),
    })
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => m.name)).toEqual([
      'Work laptop',
      'Desktop',
    ])

    state.failWrites = true
    await expect(unlink.mutate({ machineId: idOne })).rejects.toThrow()
    await expect(rename.mutate({ machineId: idOne, name: 'Nope' })).rejects.toThrow()
    expect(await list()).toEqual(['Work laptop', 'Desktop'])
    expect(loadMachines().map((m) => m.id)).toEqual([idOne])

    state.failWrites = false
    await unlink.mutate({ machineId: idOne })
    expect(state.requests.at(-2)).toMatchObject({ method: 'DELETE', path: `/api/machines/${idOne}` })
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => m.name)).toEqual(['Desktop'])
    expect(loadMachines()).toEqual([])
    stop()
  })
})

describe('a connect link', () => {
  test('opens the machine in this browser only: nothing is sent to the account, signed in or out', async () => {
    for (const user of [null, userA]) {
      const { queryClient, state } = await setup(user)
      const stop = user ? watchList(queryClient, user.id) : () => {}
      if (user) await queryClient.fetchQuery(machinesQuery(user.id))
      state.requests.length = 0

      acceptConnectLink(connectWindow(idOne))
      // Gives a request that something sent a moment to arrive.
      await Bun.sleep(20)
      expect(state.requests).toEqual([])
      expect(loadMachines()).toEqual([{ id: idOne, name: `Machine ${idOne.slice(0, 8)}`, key: accessKey }])
      if (user) expect(queryClient.getQueryData(machinesQuery(user.id).queryKey)?.machines).toEqual([])
      stop()
    }
  })
})

describe('relayTicketFor', () => {
  test('answers the ticket for a listed machine, null for one the account lacks, and throws on other failures', async () => {
    const answer = { ticket: 'fake.relay.ticket', expiresAt: '2026-10-30T12:01:00.000Z' }
    const asked: unknown[] = []
    server.use(
      http.post(`*/api/machines/${idOne}/relay-ticket`, async ({ request }) => {
        asked.push(await request.json())
        return HttpResponse.json(answer)
      }),
      http.post(`*/api/machines/${idTwo}/relay-ticket`, () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 }),
      ),
    )
    expect(await relayTicketFor(idOne)).toEqual(answer)
    // The machine id goes in the path, so the body is empty.
    expect(asked).toEqual([{}])
    expect(await relayTicketFor(idTwo)).toBeNull()

    server.use(
      http.post(`*/api/machines/${idOne}/relay-ticket`, () =>
        HttpResponse.json({ error: { code: 'internal', message: 'Failed.' } }, { status: 500 }),
      ),
    )
    await expect(relayTicketFor(idOne)).rejects.toThrow()
  })
})

describe('newMachine', () => {
  test('is the first machine not listed when the key was created, and none when every one was', () => {
    const idThree = 'C'.repeat(43)
    const baseline = [idOne]
    expect(newMachine(baseline, [machine(idOne, 'Laptop')])).toBeUndefined()
    expect(newMachine(baseline, [])).toBeUndefined()
    expect(
      newMachine(baseline, [machine(idOne, 'Laptop'), machine(idTwo, 'Desktop'), machine(idThree, 'Server')]),
    ).toMatchObject({ machineId: idTwo, name: 'Desktop' })
    expect(newMachine([], [machine(idOne, 'Laptop')])?.machineId).toBe(idOne)
  })
})
