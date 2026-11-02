import { afterEach, describe, expect, jest, test } from 'bun:test'
import { formatConnectFragment, linkMachineBody, type ServerMachine, serverRoutes } from '@orch/shared'
import { FormApi } from '@tanstack/react-form'
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { authError, authSession, authUser } from '../test/betterAuth'
import { server } from '../test/msw'
import {
  machinesQuery,
  renameMachineFormOptions,
  renameMachineMutation,
  sendPendingMachineLink,
  unlinkMachineMutation,
} from './accountMachines'
import { accountKey, refetchSession, type SessionUser, signInWithEmail, signOut, watchIdentity } from './auth'
import { acceptConnectLink, type ConnectWindow, loadMachines, saveMachine } from './machines'
import { readPendingMachineLink, setPendingMachineLink } from './pendingLink'

const userA: SessionUser = { id: 'user-a', email: 'a@example.com', name: 'Ada' }
const userB: SessionUser = { id: 'user-b', email: 'b@example.com', name: 'Bob' }

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
 * user's machines, whether a proxy in front answers links as unavailable, whether writes fail, and every request.
 */
function fakeServer(user: SessionUser | null) {
  const state = {
    user,
    machines: {} as Record<string, ServerMachine[]>,
    unavailable: false,
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
    http.post('*/api/auth/sign-in/email', async ({ request }) => {
      const { email } = (await request.json()) as { email: string }
      state.user = [userA, userB].find((u) => u.email === email) ?? null
      if (!state.user) return authError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password')
      return HttpResponse.json({ redirect: false, token: 't1', user: authUser(state.user) })
    }),
    http.post('*/api/auth/sign-out', () => {
      state.user = null
      return HttpResponse.json({ success: true })
    }),
    http.get(`*${serverRoutes.machines.list.path}`, () => {
      const list = mine()
      return list ? HttpResponse.json({ machines: list }) : unauthorized()
    }),
    http.post(`*${serverRoutes.machines.link.path}`, async ({ request }) => {
      const list = mine()
      if (!list) return unauthorized()
      if (state.unavailable) return new HttpResponse('Service Unavailable', { status: 503 })
      const parsed = linkMachineBody.safeParse(await request.json())
      if (!parsed.success) return serverError(400, 'bad_request')
      const { machineId, name } = parsed.data
      const linked = list.find((m) => m.machineId === machineId) ?? machine(machineId, name)
      if (!list.includes(linked)) list.unshift(linked)
      return HttpResponse.json(linked)
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

const posts = (state: { requests: { method: string; path: string; body: string }[] }) =>
  state.requests.filter((r) => r.method === 'POST' && r.path === serverRoutes.machines.link.path)

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

describe('sendPendingMachineLink', () => {
  test('a connect link opened while signed in links the machine with its id and name only', async () => {
    const { queryClient, state } = await setup(userA)
    const stop = watchList(queryClient, userA.id)
    await queryClient.fetchQuery(machinesQuery(userA.id))
    acceptConnectLink(connectWindow(idOne))
    expect(localStorage.getItem('orch-pending-machine-link')).not.toContain(accessKey)

    await sendPendingMachineLink(queryClient)
    expect(posts(state)).toHaveLength(1)
    const body = String(posts(state)[0]?.body)
    expect(JSON.parse(body)).toEqual({ machineId: idOne, name: `Machine ${idOne.slice(0, 8)}` })
    expect(body).not.toContain(accessKey)
    expect(readPendingMachineLink()).toBeNull()
    expect(loadMachines()[0]?.key).toBe(accessKey)

    // The list was read again and now holds the machine; the key is in no query.
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => m.machineId)).toEqual([
      idOne,
    ])
    const keys = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.state.data]),
    )
    expect(keys).not.toContain(accessKey)
    expect(state.requests.some((r) => r.body.includes(accessKey))).toBe(false)
    stop()
  })

  test('a link opened while signed out is sent once after signing in, and a refusal drops it', async () => {
    const { queryClient, state } = await setup(null)
    acceptConnectLink(connectWindow(idOne))
    await sendPendingMachineLink(queryClient)
    expect(posts(state)).toEqual([])

    expect(await signInWithEmail(queryClient, userA.email, 'pw')).toBeNull()
    // The root layout's effect can run twice, as it does under StrictMode.
    await Promise.all([sendPendingMachineLink(queryClient), sendPendingMachineLink(queryClient)])
    expect(posts(state)).toHaveLength(1)
    expect(readPendingMachineLink()).toBeNull()

    // A proxy's 503 keeps the link to try again; the server refusing the id drops it.
    for (const [unavailable, kept] of [
      [true, true],
      [false, false],
    ] as const) {
      setPendingMachineLink({ machineId: 'not-a-machine-id', name: 'Machine not-a-ma' })
      state.unavailable = unavailable
      await sendPendingMachineLink(queryClient)
      expect(readPendingMachineLink() !== null).toBe(kept)
    }
  })

  test('signing out or switching accounts drops the link before anything is sent for the next user', async () => {
    const { queryClient, state } = await setup(userA)
    state.unavailable = true
    acceptConnectLink(connectWindow(idOne))
    await sendPendingMachineLink(queryClient)
    expect(readPendingMachineLink()).not.toBeNull()

    state.unavailable = false
    state.user = userB
    await refetchSession(queryClient)
    await sendPendingMachineLink(queryClient)
    expect(readPendingMachineLink()).toBeNull()

    acceptConnectLink(connectWindow(idTwo))
    await signOut(queryClient)
    expect(readPendingMachineLink()).toBeNull()
    expect(posts(state).filter((r) => r.body.includes(idOne))).toHaveLength(1)
    expect(state.machines[userB.id] ?? []).toEqual([])
  })
})
