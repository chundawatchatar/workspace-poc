import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import { formatConnectFragment, type ServerMachine, serverRoutes } from '@orch/shared'
import { FormApi } from '@tanstack/react-form'
import { environmentManager, MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query'
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
import { installMemoryStorage, uninstallMemoryStorage } from './testStorage'

const userA: SessionUser = { id: 'user-a', email: 'a@example.com', name: 'Ada' }
const userB: SessionUser = { id: 'user-b', email: 'b@example.com', name: 'Bob' }

// Machine ids have the relay's shape: 43 base64url characters.
const idOne = 'A'.repeat(43)
const idTwo = 'B'.repeat(43)
const accessKey = 'the-access-key-value'

/** The fake server: who is signed in, each user's machines, how it answers links, and every request to it. */
const server = {
  user: null as SessionUser | null,
  machines: {} as Record<string, ServerMachine[]>,
  linkAnswer: 200,
  failWrites: false,
  requests: [] as { method: string; path: string; body: string | undefined }[],
}

function machine(machineId: string, name: string, online = false): ServerMachine {
  const at = '2026-10-30T12:00:00.000Z'
  return { machineId, name, createdAt: at, lastOpenedAt: at, online }
}

const realFetch = globalThis.fetch
const realLocation = globalThis.location

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input instanceof Request ? input.url : input), location.origin)
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? init.body : undefined
  server.requests.push({ method, path: url.pathname, body })
  const user = server.user
  if (url.pathname === '/api/auth/get-session') {
    return Response.json(user && { user: { ...user, emailVerified: true }, session: {} })
  }
  if (url.pathname === '/api/auth/sign-in/email') {
    server.user = [userA, userB].find((u) => u.email === JSON.parse(String(body)).email) ?? null
    return Response.json({ token: 't', user: server.user })
  }
  if (url.pathname === '/api/auth/sign-out') {
    server.user = null
    return Response.json({ success: true })
  }
  if (!user) return Response.json({ error: { code: 'unauthorized', message: 'Sign in.' } }, { status: 401 })
  server.machines[user.id] ??= []
  const mine = server.machines[user.id] ?? []
  const failure = (status: number) => Response.json({ error: { code: 'internal', message: 'No.' } }, { status })
  if (url.pathname === '/api/machines' && method === 'GET') return Response.json({ machines: mine })
  if (url.pathname === '/api/machines' && method === 'POST') {
    if (server.linkAnswer !== 200) return failure(server.linkAnswer)
    const { machineId, name } = JSON.parse(String(body))
    const linked = mine.find((m) => m.machineId === machineId) ?? machine(machineId, name)
    if (!mine.includes(linked)) mine.unshift(linked)
    return Response.json(linked)
  }
  const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
  const found = mine.find((m) => m.machineId === id)
  if (!found) return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
  if (server.failWrites) return failure(500)
  if (method === 'PATCH') {
    found.name = JSON.parse(String(body)).name
    return Response.json(found)
  }
  server.machines[user.id] = mine.filter((m) => m !== found)
  return Response.json({ ok: true })
}

/** A query client with the identity watcher, as `getRouter()` builds it, signed in as `user`. */
async function setup(user: SessionUser | null) {
  server.user = user
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  watchIdentity(queryClient, () => {})
  await refetchSession(queryClient)
  server.requests.length = 0
  return queryClient
}

/** Keeps the list on screen, as the home page does, so invalidating it reads it again. Returns how to stop. */
function watchList(queryClient: QueryClient, userId: string) {
  return new QueryObserver(queryClient, machinesQuery(userId)).subscribe(() => {})
}

/** Lets pending promises run, which fake timers don't hold back. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const posts = () => server.requests.filter((r) => r.method === 'POST' && r.path === '/api/machines')

/** A window that has just opened a connect link for `machineId`. */
function connectWindow(machineId: string): ConnectWindow {
  const location = new URL(`https://app.test/${formatConnectFragment({ machineId, key: accessKey })}`)
  return { location, history: { state: null, replaceState: () => {} } }
}

beforeAll(() => {
  globalThis.location = { origin: 'http://localhost:3220' } as Location
  globalThis.fetch = fakeFetch as typeof fetch
})

beforeEach(() => {
  installMemoryStorage()
  Object.assign(server, { user: null, machines: {}, linkAnswer: 200, failWrites: false, requests: [] })
})

afterEach(() => {
  jest.useRealTimers()
  environmentManager.setIsServer(() => typeof window === 'undefined')
})

afterAll(() => {
  uninstallMemoryStorage()
  globalThis.location = realLocation
  globalThis.fetch = realFetch
})

describe('the machine list', () => {
  test("is the account's machines in the server's order, keyed by the user, read again every 10 seconds", async () => {
    server.machines[userA.id] = [machine(idTwo, 'Desktop', true), machine(idOne, 'Laptop')]
    const queryClient = await setup(userA)
    saveMachine({ id: 'only-in-this-browser', name: 'Old', key: 'k' })
    expect([...machinesQuery(userA.id).queryKey]).toEqual([
      ...accountKey(userA.id, serverRoutes.machines.list.path, {}),
    ])

    // Query runs no intervals on a server, and Bun has no `window`, so it would take the test runner for one.
    environmentManager.setIsServer(() => false)
    jest.useFakeTimers()
    const stop = watchList(queryClient, userA.id)
    await settle()
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => [m.name, m.online])).toEqual(
      [
        ['Desktop', true],
        ['Laptop', false],
      ],
    )
    const lists = () => server.requests.filter((r) => r.path === '/api/machines').length
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
    server.machines[userA.id] = [machine(idOne, 'Laptop'), machine(idTwo, 'Desktop')]
    saveMachine({ id: idOne, name: 'Laptop', key: accessKey })
    const queryClient = await setup(userA)
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
    expect(server.requests.filter((r) => r.method === 'PATCH')).toEqual([])
    form.setFieldValue('name', '  Work laptop ')
    await form.handleSubmit()
    for (let i = 0; i < 50 && rename.getCurrentResult().isPending; i++) await Bun.sleep(5)
    expect(server.requests.find((r) => r.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: `/api/machines/${idOne}`,
      body: JSON.stringify({ name: 'Work laptop' }),
    })
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => m.name)).toEqual([
      'Work laptop',
      'Desktop',
    ])

    server.failWrites = true
    await expect(unlink.mutate({ machineId: idOne })).rejects.toThrow()
    await expect(rename.mutate({ machineId: idOne, name: 'Nope' })).rejects.toThrow()
    expect(await list()).toEqual(['Work laptop', 'Desktop'])
    expect(loadMachines().map((m) => m.id)).toEqual([idOne])

    server.failWrites = false
    await unlink.mutate({ machineId: idOne })
    expect(server.requests.at(-2)).toMatchObject({ method: 'DELETE', path: `/api/machines/${idOne}` })
    expect(queryClient.getQueryData(machinesQuery(userA.id).queryKey)?.machines.map((m) => m.name)).toEqual(['Desktop'])
    expect(loadMachines()).toEqual([])
    stop()
  })
})

describe('sendPendingMachineLink', () => {
  test('a connect link opened while signed in links the machine with its id and name only', async () => {
    const queryClient = await setup(userA)
    const stop = watchList(queryClient, userA.id)
    await queryClient.fetchQuery(machinesQuery(userA.id))
    acceptConnectLink(connectWindow(idOne))
    expect(localStorage.getItem('orch-pending-machine-link')).not.toContain(accessKey)

    await sendPendingMachineLink(queryClient)
    expect(posts()).toHaveLength(1)
    const body = String(posts()[0]?.body)
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
    expect(server.requests.some((r) => r.body?.includes(accessKey))).toBe(false)
    stop()
  })

  test('a link opened while signed out is sent once after signing in, and a refusal drops it', async () => {
    const queryClient = await setup(null)
    acceptConnectLink(connectWindow(idOne))
    await sendPendingMachineLink(queryClient)
    expect(posts()).toEqual([])

    expect(await signInWithEmail(queryClient, userA.email, 'pw')).toBeNull()
    // The root layout's effect can run twice, as it does under StrictMode.
    await Promise.all([sendPendingMachineLink(queryClient), sendPendingMachineLink(queryClient)])
    expect(posts()).toHaveLength(1)
    expect(readPendingMachineLink()).toBeNull()

    for (const [answer, kept] of [
      [503, true],
      [400, false],
    ] as const) {
      setPendingMachineLink({ machineId: 'not-a-machine-id', name: 'Machine not-a-ma' })
      server.linkAnswer = answer
      await sendPendingMachineLink(queryClient)
      expect(readPendingMachineLink() !== null).toBe(kept)
    }
  })

  test('signing out or switching accounts drops the link before anything is sent for the next user', async () => {
    const queryClient = await setup(userA)
    server.linkAnswer = 503
    acceptConnectLink(connectWindow(idOne))
    await sendPendingMachineLink(queryClient)
    expect(readPendingMachineLink()).not.toBeNull()

    server.linkAnswer = 200
    server.user = userB
    await refetchSession(queryClient)
    await sendPendingMachineLink(queryClient)
    expect(readPendingMachineLink()).toBeNull()

    acceptConnectLink(connectWindow(idTwo))
    await signOut(queryClient)
    expect(readPendingMachineLink()).toBeNull()
    expect(posts().filter((r) => r.body?.includes(idOne))).toHaveLength(1)
    expect(server.machines[userB.id] ?? []).toEqual([])
  })
})
