import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import {
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
import { answerChallenge, createTestMachineKey } from '../tunnel/tunnel.testing'
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

type Answer = Extract<ServerFrame, { type: 'enroll.redeemed' | 'enroll.failed' | 'unlinked' | 'unlink.failed' }>
const isAnswer = (frame: ServerFrame): frame is Answer =>
  frame.type.startsWith('enroll.') || frame.type.startsWith('unlink')

/** A welcomed test machine with a fresh machine key. Every frame it sends gets its own id. */
async function machine() {
  const key = await createTestMachineKey()
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  sockets.push(ws)
  answerChallenge(ws, key)
  const frames: ServerFrame[] = []
  const raw: string[] = []
  ws.addEventListener('message', (event) => {
    raw.push(String(event.data))
    const frame = decodeFrame(serverFrame, event.data)
    if (frame) frames.push(frame)
  })
  await until(() => frames.some((frame) => frame.type === 'welcome'))
  let nextId = 1
  const answer = async (id: number): Promise<Answer> => {
    const find = () => frames.filter(isAnswer).find((frame) => frame.id === id)
    await until(() => find() !== undefined)
    return find() as Answer
  }
  return {
    machineId: key.machineId,
    raw,
    /** The answers so far, by id. */
    answered: (id: number) => frames.filter(isAnswer).some((frame) => frame.id === id),
    redeem(key: string, email: string, name = 'Box') {
      const id = nextId++
      ws.send(encodeFrame({ type: 'enroll.redeem', id, key, email, name }))
      return answer(id)
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
  }
}

const unknownKey = () => `oek_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`

/** Links `machineId` to `user` the way redeeming a key does, without a tunnel. */
function link(user: User, machineId: string, name: string) {
  return new MachinesService(domain.forUser({ userId: user.userId }).machines, ctx.registry).link(machineId, name)
}

/** The machine ids `user` lists. */
const idsOf = async (user: User) => (await machinesOf(user)).map((m) => m.machineId).sort()

describe('enrollment over the tunnel', () => {
  test("redeeming with the owner's email, in any case and with spaces, links only the tunnel machine", async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    const ada = await signedIn('Ada Lovelace')
    const bob = await signedIn('Bob Builder')
    const created = await createKey(ada)
    const box = await machine()
    const account = { name: 'Ada Lovelace', maskedEmail: maskEmail(ada.email) }
    expect(maskEmail('alice@example.com')).toBe('a***@example.com')

    expect(await box.redeem(created.key, `  ${ada.email.toUpperCase()} `, '  Build box  ')).toEqual({
      type: 'enroll.redeemed',
      id: 1,
      machineId: box.machineId,
      accountId: ada.userId,
      account,
      relayKeys: ctx.relayTickets.publicKeys,
    })
    expect((await enrollmentRow(created.key))?.usedAt).toBeInstanceOf(Date)
    const [linked] = await machinesOf(ada)
    expect(linked).toMatchObject({ machineId: box.machineId, name: 'Build box', online: true, remoteOff: false })
    expect(await machinesOf(bob)).toEqual([])

    // A second key for a machine the owner already has keeps its name and refreshes `lastOpenedAt`.
    await Bun.sleep(5)
    const again = await createKey(ada)
    expect((await box.redeem(again.key, ada.email, 'Other name')).type).toBe('enroll.redeemed')
    const [relinked] = await machinesOf(ada)
    expect(relinked).toMatchObject({ machineId: box.machineId, name: 'Build box', createdAt: linked?.createdAt })
    expect(Date.parse(relinked?.lastOpenedAt ?? '')).toBeGreaterThan(Date.parse(linked?.lastOpenedAt ?? ''))

    const secrets = [created.key, hashEnrollmentKey(created.key), ada.email, ada.email.toUpperCase(), ada.name]
    const seen = [...lookups, ...logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))]
    expect(seen.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
    const answers = box.raw.filter((text) => text.includes('enroll.'))
    expect(answers.some((text) => text.includes(ada.email) || text.includes(created.key))).toBe(false)
  })

  test('unknown, used, expired and malformed keys and wrong emails all get invalid_key, and a wrong email uses nothing', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    const ada = await signedIn('Ada')
    const bob = await signedIn('Bob')
    const used = await createKey(ada)
    expect((await (await machine()).redeem(used.key, ada.email, 'First')).type).toBe('enroll.redeemed')
    const expired = await createKey(ada)
    const pending = await createKey(ada)
    offsetMs = 15 * 60_000 + 1000
    const fresh = await createKey(ada)

    const box = await machine()
    const answers: Answer[] = []
    for (const key of [unknownKey(), used.key, expired.key, 'oek_short', '']) {
      answers.push(await box.redeem(key, ada.email))
    }
    // Another account's email, an email with no account, and a malformed one, with a key that still works. Another
    // machine sends them, since each machine has only 10 tries a minute.
    const typo = await machine()
    const wrong = [bob.email, 'nobody@test.example', 'not an email', '', `${ada.email}x`]
    for (const email of wrong) answers.push(await typo.redeem(fresh.key, email))
    expect(answers.map(({ id: _, ...rest }) => rest)).toEqual(
      answers.map(() => ({ type: 'enroll.failed', code: 'invalid_key' })),
    )
    expect((await enrollmentRow(expired.key))?.usedAt).toBeNull()
    expect((await enrollmentRow(pending.key))?.usedAt).toBeNull()
    expect((await enrollmentRow(fresh.key))?.usedAt).toBeNull()
    expect(await idsOf(ada)).not.toContain(box.machineId)

    // The same key still links once it comes with the owner's email.
    expect((await typo.redeem(fresh.key, ada.email)).type).toBe('enroll.redeemed')
    expect(await idsOf(ada)).toContain(typo.machineId)
    const seen = [...lookups, ...logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))]
    for (const secret of [fresh.key, ada.email, bob.email]) {
      expect(seen.filter((line) => line.includes(secret))).toEqual([])
    }
  })

  test('two machines redeeming one key at once get exactly one success', async () => {
    const ada = await signedIn('Ada')
    const { key } = await createKey(ada)
    const [one, two] = [await machine(), await machine()]
    const answers = await Promise.all([one.redeem(key, ada.email, 'One'), two.redeem(key, ada.email, 'Two')])
    expect(answers.map((answer) => answer.type).sort()).toEqual(['enroll.failed', 'enroll.redeemed'])
    const winner = answers[0]?.type === 'enroll.redeemed' ? one : two
    expect(await idsOf(ada)).toEqual([winner.machineId])
  })

  test('a machine out of enrollment tokens is refused before any lookup, and another machine is still admitted', async () => {
    const box = await machine()
    for (let i = 0; i < 9; i++)
      expect(await box.redeem(unknownKey(), 'a@test.example')).toMatchObject({ code: 'invalid_key' })
    expect(await box.unlink('u1')).toEqual({ type: 'unlinked', id: 10 })
    const before = lookups.length
    expect(await box.redeem(unknownKey(), 'a@test.example')).toEqual({
      type: 'enroll.failed',
      id: 11,
      code: 'rate_limited',
    })
    expect(await box.unlink('u1')).toEqual({ type: 'unlink.failed', id: 12, code: 'rate_limited' })
    expect(lookups.length).toBe(before)

    // Same IP, another machine: the bucket is per machine id.
    expect(await (await machine()).redeem(unknownKey(), 'a@test.example')).toMatchObject({ code: 'invalid_key' })
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
