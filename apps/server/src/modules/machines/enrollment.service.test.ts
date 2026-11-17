import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import {
  type ConnectRequest,
  type CreateEnrollmentResponse,
  decodeFrame,
  encodeFrame,
  type ServerFrame,
  type ServerMachine,
  serverFrame,
  TUNNEL_PATH,
} from '@orch/shared'
import type { Server } from 'bun'
import { eq } from 'drizzle-orm'
import { serverWebSocket } from '../../lib/websocket'
import { accountsTestApp, cookiePair } from '../auth/auth.testing'
import { ConnectionLimiter } from '../limits/limits.service'
import { answerChallenge, createTestMachineKey, type TestMachineKey } from '../tunnel/tunnel.testing'
import { hashEnrollmentKey, maskEmail } from './enrollment.service'
import { MachinesService } from './machines.service'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>
let server: Server<unknown>
/** Every line `skipAuthorization` logged, one per key lookup. */
const lookups: string[] = []
/** How far the enrollment clock runs ahead of real time. */
let offsetMs = 0
const sockets: WebSocket[] = []

beforeAll(async () => {
  domain = await createTestDomain({ log: (line) => lookups.push(line) })
  ctx = accountsTestApp(domain, '10.7.0', {
    now: () => new Date(Date.now() + offsetMs),
    // Every test tunnel comes from 127.0.0.1, so the per-IP upgrade limit is lifted.
    limiter: new ConnectionLimiter({ tunnelPerIp: { capacity: 1000, refillEveryMs: 1 } }),
  })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => ctx.app.fetch(request, bunServer),
    websocket: serverWebSocket,
  })
})

afterEach(() => {
  offsetMs = 0
  mock.restore()
  for (const ws of sockets.splice(0)) ws.close()
})

afterAll(async () => {
  await server.stop(true)
  await domain.close()
})

interface User {
  userId: string
  email: string
  name: string
  ip: string
  cookie: string
}

async function signedIn(name: string): Promise<User> {
  const email = ctx.client.freshEmail()
  const ip = ctx.client.freshIp()
  const cookie = cookiePair(await ctx.client.verifiedUser(email, ip, name))
  const [row] = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
  return { userId: row?.id as string, email, name, ip, cookie }
}

async function createKey(user: User): Promise<CreateEnrollmentResponse> {
  const response = await ctx.client.call('POST', '/api/machines/enrollments', { ...user, body: {} })
  expect(response.status).toBe(200)
  return (await response.json()) as CreateEnrollmentResponse
}

async function machinesOf(user: User): Promise<ServerMachine[]> {
  const response = await ctx.client.call('GET', '/api/machines', user)
  return ((await response.json()) as { machines: ServerMachine[] }).machines
}

async function enrollmentRow(key: string) {
  const [row] = await domain
    .skipAuthorization('test: read an enrollment row')
    .select()
    .from(schema.machineEnrollments)
    .where(eq(schema.machineEnrollments.keyHash, hashEnrollmentKey(key)))
  return row
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

type Answer = Extract<
  ServerFrame,
  { type: 'enroll.waiting' | 'enroll.redeemed' | 'enroll.failed' | 'unlinked' | 'unlink.failed' }
>
const isAnswer = (frame: ServerFrame): frame is Answer =>
  frame.type.startsWith('enroll.') || frame.type.startsWith('unlink')

/**
 * A welcomed test machine, with a fresh machine key or `key` to come back as the same machine. Every frame it sends
 * gets its own id.
 */
async function machine(key?: TestMachineKey) {
  const machineKey = key ?? (await createTestMachineKey())
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  sockets.push(ws)
  answerChallenge(ws, machineKey)
  const frames: ServerFrame[] = []
  const raw: string[] = []
  ws.addEventListener('message', (event) => {
    raw.push(String(event.data))
    const frame = decodeFrame(serverFrame, event.data)
    if (frame) frames.push(frame)
  })
  await until(() => frames.some((frame) => frame.type === 'welcome'))
  let nextId = 1
  /** The answers to the frame `id`, in order: a request's first answer, then its final one. */
  const answersTo = (id: number) => frames.filter(isAnswer).filter((frame) => frame.id === id)
  const answer = async (id: number): Promise<Answer> => {
    await until(() => answersTo(id).length > 0)
    return answersTo(id)[0] as Answer
  }
  return {
    key: machineKey,
    machineId: machineKey.machineId,
    raw,
    answersTo,
    /** True once anything answered the frame `id`. */
    answered: (id: number) => answersTo(id).length > 0,
    /** Sends `enroll.request` and answers its first answer. */
    request(key: string, email: string, name = 'Box') {
      const id = nextId++
      ws.send(encodeFrame({ type: 'enroll.request', id, key, email, name }))
      return answer(id)
    },
    /** The final answer to the request frame `id`, once the owner answered it. */
    async final(id: number): Promise<Answer> {
      await until(() => answersTo(id).length > 1)
      return answersTo(id)[1] as Answer
    },
    unlink(accountId: string) {
      const id = nextId++
      ws.send(encodeFrame({ type: 'unlink', id, accountId }))
      return answer(id)
    },
    /** Sends a frame as raw JSON, bypassing the types, and answers its id. */
    sendRaw(frame: Record<string, unknown>) {
      const id = nextId++
      ws.send(JSON.stringify({ ...frame, id }))
      return id
    },
    /** Closes the tunnel and waits until the server has let it go. */
    async close() {
      ws.close()
      await until(() => ctx.registry.get(machineKey.machineId) === undefined)
    },
  }
}

const unknownKey = () => `oek_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`

/** Links `machineId` to `user` the way an accepted request does, without a tunnel. */
function link(user: User, machineId: string, name: string) {
  return new MachinesService(domain.forUser({ userId: user.userId }).machines, ctx.registry).link(machineId, name)
}

/** The machine ids `user` lists. */
const idsOf = async (user: User) => (await machinesOf(user)).map((m) => m.machineId).sort()

/** The connect requests `user` sees waiting. */
async function requestsOf(user: User): Promise<ConnectRequest[]> {
  const response = await ctx.client.call('GET', '/api/machines/requests', user)
  expect(response.status).toBe(200)
  return ((await response.json()) as { requests: ConnectRequest[] }).requests
}

/** Accepts or rejects the request `id` as `user`, answering the status and the body. */
async function answerAs(user: User, id: string, answer: 'accept' | 'reject', body: unknown = {}) {
  const response = await ctx.client.call('POST', `/api/machines/requests/${id}/${answer}`, { ...user, body })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const notWaiting = { status: 409, body: { error: { code: 'not_waiting', message: expect.any(String) } } }
const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } }

/** Every line logged so far, by `skipAuthorization` and the console spies. */
const seen = (logs: { mock: { calls: unknown[][] } }[]) => [
  ...lookups,
  ...logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' '))),
]

describe('connect requests over the tunnel', () => {
  test("a request with the owner's email, in any case and with spaces, waits with the key's time left and links nothing", async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    const ada = await signedIn('Ada Lovelace')
    const bob = await signedIn('Bob Builder')
    const created = await createKey(ada)
    const box = await machine()

    const waiting = await box.request(created.key, `  ${ada.email.toUpperCase()} `, '  Build box  ')
    expect(waiting).toEqual({ type: 'enroll.waiting', id: 1, expiresInMs: expect.any(Number) })
    const left = waiting.type === 'enroll.waiting' ? waiting.expiresInMs : 0
    const shouldBe = Date.parse(created.expiresAt) - Date.now()
    expect(Math.abs(left - shouldBe)).toBeLessThan(2000)
    const row = await enrollmentRow(created.key)
    expect(row).toMatchObject({ requestMachineId: box.machineId, requestName: 'Build box', usedAt: null })
    expect(row?.requestedAt).toBeInstanceOf(Date)
    expect(await machinesOf(ada)).toEqual([])
    expect(await machinesOf(bob)).toEqual([])

    // The same machine asking again with the key that holds its own request waits again.
    expect(await box.request(created.key, ada.email, 'Build box')).toMatchObject({ type: 'enroll.waiting', id: 2 })
    expect(await requestsOf(ada)).toEqual([
      {
        id: created.id,
        machineId: box.machineId,
        name: 'Build box',
        requestedAt: expect.any(String),
        expiresAt: created.expiresAt,
      },
    ])

    const secrets = [created.key, hashEnrollmentKey(created.key), ada.email, ada.email.toUpperCase(), 'Build box']
    expect(seen(logs).filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
    const answers = box.raw.filter((text) => text.includes('enroll.'))
    expect(answers.some((text) => text.includes(ada.email) || text.includes(created.key))).toBe(false)
  })

  test("unknown, used, expired and malformed keys, wrong emails and another machine's key get invalid_key and change nothing", async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    const ada = await signedIn('Ada')
    const bob = await signedIn('Bob')
    const used = await createKey(ada)
    const first = await machine()
    await first.request(used.key, ada.email, 'First')
    expect((await answerAs(ada, used.id, 'reject')).status).toBe(200)
    const expired = await createKey(ada)
    const pending = await createKey(ada)
    offsetMs = 15 * 60_000 + 1000
    const fresh = await createKey(ada)
    const held = await createKey(ada)
    const holder = await machine()
    expect((await holder.request(held.key, ada.email, 'Holder')).type).toBe('enroll.waiting')
    const rowsBefore = await Promise.all([used, expired, pending, fresh, held].map(({ key }) => enrollmentRow(key)))

    const box = await machine()
    const answers: Answer[] = []
    for (const key of [unknownKey(), used.key, expired.key, 'oek_short', '', held.key]) {
      answers.push(await box.request(key, ada.email))
    }
    // Another account's email, an email with no account, and a malformed one, with a key that still works. Another
    // machine sends them, since each machine has only 10 tries at once.
    const typo = await machine()
    const wrong = [bob.email, 'nobody@test.example', 'not an email', '', `${ada.email}x`]
    for (const email of wrong) answers.push(await typo.request(fresh.key, email))
    expect(answers.map(({ id: _, ...rest }) => rest)).toEqual(
      answers.map(() => ({ type: 'enroll.failed', code: 'invalid_key' })),
    )
    const rowsAfter = await Promise.all([used, expired, pending, fresh, held].map(({ key }) => enrollmentRow(key)))
    expect(rowsAfter).toEqual(rowsBefore)
    expect(rowsAfter[3]).toMatchObject({ requestMachineId: null, usedAt: null })
    expect(rowsAfter[4]).toMatchObject({ requestMachineId: holder.machineId, usedAt: null })
    expect(await idsOf(ada)).toEqual([])

    // The same key still works once it comes with the owner's email.
    expect((await typo.request(fresh.key, ada.email)).type).toBe('enroll.waiting')
    for (const secret of [fresh.key, ada.email, bob.email]) {
      expect(seen(logs).filter((line) => line.includes(secret))).toEqual([])
    }
  })

  test('a request ends when its tunnel closes or its key expires, and the same machine can ask again', async () => {
    const ada = await signedIn('Ada')
    const closing = await createKey(ada)
    const box = await machine()
    await box.request(closing.key, ada.email, 'Box')
    expect((await requestsOf(ada)).map((r) => r.id)).toEqual([closing.id])

    await box.close()
    expect(await requestsOf(ada)).toEqual([])
    expect(await answerAs(ada, closing.id, 'accept')).toEqual(notWaiting)
    expect((await enrollmentRow(closing.key))?.usedAt).toBeNull()
    // The row keeps the machine, so it asks again with the same key, and only it can.
    const back = await machine(box.key)
    expect((await back.request(closing.key, ada.email, 'Box')).type).toBe('enroll.waiting')
    expect((await requestsOf(ada)).map((r) => r.id)).toEqual([closing.id])
    expect((await (await machine()).request(closing.key, ada.email)).type).toBe('enroll.failed')

    const expiring = await createKey(ada)
    const other = await machine()
    await other.request(expiring.key, ada.email, 'Other')
    offsetMs = 15 * 60_000 + 1000
    expect(await requestsOf(ada)).toEqual([])
    expect(await answerAs(ada, expiring.id, 'reject')).toEqual(notWaiting)
    expect((await enrollmentRow(expiring.key))?.usedAt).toBeNull()
    expect(other.answersTo(1)).toHaveLength(1)
  })

  test('two machines asking with one key at once: exactly one waits', async () => {
    const ada = await signedIn('Ada')
    const { key } = await createKey(ada)
    const [one, two] = [await machine(), await machine()]
    const answers = await Promise.all([one.request(key, ada.email, 'One'), two.request(key, ada.email, 'Two')])
    expect(answers.map((answer) => answer.type).sort()).toEqual(['enroll.failed', 'enroll.waiting'])
    const winner = answers[0]?.type === 'enroll.waiting' ? one : two
    expect((await requestsOf(ada)).map((r) => r.machineId)).toEqual([winner.machineId])
  })

  test('a machine out of enrollment tokens is refused before any lookup, and another machine is still admitted', async () => {
    const box = await machine()
    for (let i = 0; i < 9; i++)
      expect(await box.request(unknownKey(), 'a@test.example')).toMatchObject({ code: 'invalid_key' })
    expect(await box.unlink('u1')).toEqual({ type: 'unlinked', id: 10 })
    const before = lookups.length
    expect(await box.request(unknownKey(), 'a@test.example')).toEqual({
      type: 'enroll.failed',
      id: 11,
      code: 'rate_limited',
    })
    expect(await box.unlink('u1')).toEqual({ type: 'unlink.failed', id: 12, code: 'rate_limited' })
    expect(lookups.length).toBe(before)

    // Same IP, another machine: the bucket is per machine id.
    expect(await (await machine()).request(unknownKey(), 'a@test.example')).toMatchObject({ code: 'invalid_key' })
  })

  test('a database error answers `unavailable`, never `invalid_key`, and logs no key, email or error', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      spyOn(console, method).mockImplementation(() => {}),
    )
    const ada = await signedIn('Ada')
    const { key } = await createKey(ada)
    // A driver error can quote the query's parameters, so this one does.
    const failure = () => {
      throw new Error(`connection refused while running a query with ${key} and ${ada.email}`)
    }
    const broken = [
      spyOn(domain, 'skipAuthorization').mockImplementation(failure),
      spyOn(domain, 'forUser').mockImplementation(failure),
    ]
    const box = await machine()
    expect(await box.request(key, ada.email)).toEqual({ type: 'enroll.failed', id: 1, code: 'unavailable' })
    expect(await box.unlink(ada.userId)).toEqual({ type: 'unlink.failed', id: 2, code: 'unavailable' })
    for (const spy of broken) spy.mockRestore()

    expect((await enrollmentRow(key))?.requestMachineId).toBeNull()
    expect(seen(logs)).toContain('account frame failed')
    for (const line of seen(logs)) {
      for (const secret of [key, ada.email, ada.userId, 'connection refused']) expect(line).not.toContain(secret)
    }
  })
})

describe("the owner's answer", () => {
  test("listRequests answers only the caller's waiting requests, newest first", async () => {
    const ada = await signedIn('Ada')
    const bob = await signedIn('Bob')
    const [older, newer, bobs] = [await createKey(ada), await createKey(ada), await createKey(bob)]
    const [laptop, desktop, bobBox] = [await machine(), await machine(), await machine()]
    await laptop.request(older.key, ada.email, 'Laptop')
    await Bun.sleep(5)
    await desktop.request(newer.key, ada.email, 'Desktop')
    await bobBox.request(bobs.key, bob.email, 'Bob box')

    const listed = await requestsOf(ada)
    expect(listed.map((r) => [r.id, r.machineId, r.name])).toEqual([
      [newer.id, desktop.machineId, 'Desktop'],
      [older.id, laptop.machineId, 'Laptop'],
    ])
    expect(Date.parse(listed[0]?.requestedAt ?? '')).toBeGreaterThan(Date.parse(listed[1]?.requestedAt ?? ''))
    expect((await requestsOf(bob)).map((r) => r.name)).toEqual(['Bob box'])
    // Listing changes nothing.
    expect((await enrollmentRow(older.key))?.usedAt).toBeNull()
    expect(laptop.answersTo(1)).toHaveLength(1)

    // A tunnel holds one request: asking with another key replaces the earlier one.
    const replacing = await createKey(ada)
    await laptop.request(replacing.key, ada.email, 'Laptop')
    expect((await requestsOf(ada)).map((r) => [r.id, r.name])).toEqual([
      [replacing.id, 'Laptop'],
      [newer.id, 'Desktop'],
    ])
    expect(await answerAs(ada, older.id, 'accept')).toEqual(notWaiting)
  })

  test('accept uses the key, links the machine under its name, tells it, and the key then fails for any machine', async () => {
    const ada = await signedIn('Ada Lovelace')
    const created = await createKey(ada)
    const box = await machine()
    await box.request(created.key, ada.email, 'Build box')

    const accepted = await answerAs(ada, created.id, 'accept')
    expect(accepted).toEqual({
      status: 200,
      body: expect.objectContaining({ machineId: box.machineId, name: 'Build box', online: true, remoteOff: false }),
    })
    expect(await box.final(1)).toEqual({
      type: 'enroll.redeemed',
      id: 1,
      machineId: box.machineId,
      accountId: ada.userId,
      account: { name: 'Ada Lovelace', maskedEmail: maskEmail(ada.email) },
      relayKeys: ctx.relayTickets.publicKeys,
    })
    expect(maskEmail('alice@example.com')).toBe('a***@example.com')
    expect((await enrollmentRow(created.key))?.usedAt).toBeInstanceOf(Date)
    expect(await idsOf(ada)).toEqual([box.machineId])
    expect(await requestsOf(ada)).toEqual([])

    expect(await answerAs(ada, created.id, 'accept')).toEqual(notWaiting)
    expect(await answerAs(ada, created.id, 'reject')).toEqual(notWaiting)
    expect(box.answersTo(1)).toHaveLength(2)
    expect((await box.request(created.key, ada.email, 'Build box')).type).toBe('enroll.failed')
    expect((await (await machine()).request(created.key, ada.email)).type).toBe('enroll.failed')

    // A machine the owner already has keeps its name when another of its requests is accepted.
    await Bun.sleep(5)
    const again = await createKey(ada)
    await box.request(again.key, ada.email, 'Other name')
    const relinked = await answerAs(ada, again.id, 'accept')
    expect(relinked.body).toMatchObject({ name: 'Build box', createdAt: accepted.body.createdAt })
    expect(Date.parse(String(relinked.body.lastOpenedAt))).toBeGreaterThan(
      Date.parse(String(accepted.body.lastOpenedAt)),
    )
  })

  test('reject uses the key, tells the machine and links nothing, and the key then fails for any machine', async () => {
    const ada = await signedIn('Ada')
    const created = await createKey(ada)
    const box = await machine()
    await box.request(created.key, ada.email, 'Box')

    expect(await answerAs(ada, created.id, 'reject')).toEqual({ status: 200, body: { ok: true } })
    expect(await box.final(1)).toEqual({ type: 'enroll.failed', id: 1, code: 'rejected' })
    expect((await enrollmentRow(created.key))?.usedAt).toBeInstanceOf(Date)
    expect(await idsOf(ada)).toEqual([])
    expect(await requestsOf(ada)).toEqual([])
    expect(await answerAs(ada, created.id, 'accept')).toEqual(notWaiting)
    expect((await box.request(created.key, ada.email)).type).toBe('enroll.failed')
    expect((await (await machine()).request(created.key, ada.email)).type).toBe('enroll.failed')
  })

  test("another user's request is not found, one with no request is not waiting, and neither links, sends or uses anything", async () => {
    const ada = await signedIn('Ada')
    const bob = await signedIn('Bob')
    const created = await createKey(ada)
    const unasked = await createKey(ada)
    const box = await machine()
    await box.request(created.key, ada.email, 'Box')

    for (const answer of ['accept', 'reject'] as const) {
      expect(await answerAs(bob, created.id, answer)).toEqual(notFound)
      expect(await answerAs(ada, crypto.randomUUID(), answer)).toEqual(notFound)
      expect(await answerAs(ada, unasked.id, answer)).toEqual(notWaiting)
      // The input is strict: a key or a machine id in the body is refused.
      for (const body of [{ key: created.key }, { machineId: box.machineId }]) {
        expect((await answerAs(ada, created.id, answer, body)).status).toBe(400)
      }
    }
    expect((await answerAs(ada, 'not-a-request', 'accept')).status).toBe(400)
    expect(box.answersTo(1)).toHaveLength(1)
    expect((await enrollmentRow(created.key))?.usedAt).toBeNull()
    expect(await idsOf(ada)).toEqual([])
    expect(await idsOf(bob)).toEqual([])
    expect((await requestsOf(ada)).map((r) => r.id)).toEqual([created.id])
  })
})

describe('unlink over the tunnel', () => {
  test("removes only the tunnel machine's row from the named account, and answers the same either way", async () => {
    const ada = await signedIn('Ada')
    const bob = await signedIn('Bob')
    const [box, other] = [await machine(), await machine()]
    await link(ada, box.machineId, 'Box')
    await link(ada, other.machineId, 'Other')
    await link(bob, box.machineId, 'Box at Bob')

    // Another machine can't remove this one, whichever account it names.
    expect(await other.unlink(bob.userId)).toEqual({ type: 'unlinked', id: 1 })
    expect(await idsOf(bob)).toEqual([box.machineId])
    // No frame field names a machine: one that tries is dropped unanswered, and removes nothing.
    const smuggled = other.sendRaw({ type: 'unlink', accountId: ada.userId, machineId: box.machineId })
    expect(await other.unlink('no-such-account')).toEqual({ type: 'unlinked', id: 3 })
    expect(other.answered(smuggled)).toBe(false)
    expect(await idsOf(ada)).toEqual([box.machineId, other.machineId].sort())

    // The tunnel's own machine goes from the named account only, and a second time answers the same.
    expect(await box.unlink(ada.userId)).toEqual({ type: 'unlinked', id: 1 })
    expect(await idsOf(ada)).toEqual([other.machineId])
    expect(await idsOf(bob)).toEqual([box.machineId])
    expect(await box.unlink(ada.userId)).toEqual({ type: 'unlinked', id: 2 })
  })
})
