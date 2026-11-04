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
  TUNNEL_PROTOCOL_VERSION,
} from '@orch/shared'
import type { Server } from 'bun'
import { eq } from 'drizzle-orm'
import { serverWebSocket } from '../../lib/websocket'
import { accountsTestApp, cookiePair } from '../auth/auth.testing'
import { ConnectionLimiter } from '../limits/limits.service'
import { machineIdFromProof } from '../tunnel/tunnel.service'
import { hashEnrollmentKey, maskEmail } from './enrollment.service'

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

type EnrollAnswer = Extract<ServerFrame, { type: 'enroll.previewed' | 'enroll.redeemed' | 'enroll.failed' }>
const isAnswer = (frame: ServerFrame): frame is EnrollAnswer => frame.type.startsWith('enroll.')

/** A welcomed test machine with a fresh secret. Every frame it sends gets its own id. */
async function machine() {
  const proof = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${TUNNEL_PATH}`)
  sockets.push(ws)
  const frames: ServerFrame[] = []
  const raw: string[] = []
  ws.addEventListener('message', (event) => {
    raw.push(String(event.data))
    const frame = decodeFrame(serverFrame, event.data)
    if (frame) frames.push(frame)
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  ws.send(encodeFrame({ type: 'hello', version: TUNNEL_PROTOCOL_VERSION, proof }))
  await until(() => frames.some((frame) => frame.type === 'welcome'))
  let nextId = 1
  const answer = async (id: number): Promise<EnrollAnswer> => {
    const find = () => frames.filter(isAnswer).find((frame) => frame.id === id)
    await until(() => find() !== undefined)
    return find() as EnrollAnswer
  }
  return {
    machineId: machineIdFromProof(proof),
    raw,
    preview(key: string) {
      const id = nextId++
      ws.send(encodeFrame({ type: 'enroll.preview', id, key }))
      return answer(id)
    },
    redeem(key: string, name: string) {
      const id = nextId++
      ws.send(encodeFrame({ type: 'enroll.redeem', id, key, name }))
      return answer(id)
    },
  }
}

const unknownKey = () => `oek_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`

describe('enrollment over the tunnel', () => {
  test('previews show the masked owner without using the key, and redeeming links only the tunnel machine', async () => {
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) => spyOn(console, method))
    const ada = await signedIn('Ada Lovelace')
    const bob = await signedIn('Bob Builder')
    const created = await createKey(ada)
    const box = await machine()
    const account = { name: 'Ada Lovelace', maskedEmail: maskEmail(ada.email) }
    expect(maskEmail('alice@example.com')).toBe('a***@example.com')

    const previewed = { account, fingerprint: created.fingerprint, expiresAt: created.expiresAt }
    expect(await box.preview(created.key)).toEqual({ type: 'enroll.previewed', id: 1, ...previewed })
    expect(await box.preview(created.key)).toEqual({ type: 'enroll.previewed', id: 2, ...previewed })
    expect((await enrollmentRow(created.key))?.usedAt).toBeNull()

    expect(await box.redeem(created.key, '  Build box  ')).toEqual({
      type: 'enroll.redeemed',
      id: 3,
      machineId: box.machineId,
      accountId: ada.userId,
      account,
      relayKeys: ctx.relayTickets.publicKeys,
    })
    expect((await enrollmentRow(created.key))?.usedAt).toBeInstanceOf(Date)
    const [linked] = await machinesOf(ada)
    expect(linked).toMatchObject({ machineId: box.machineId, name: 'Build box', online: true })
    expect(await machinesOf(bob)).toEqual([])

    // A second key for a machine the owner already has keeps its name and refreshes `lastOpenedAt`.
    await Bun.sleep(5)
    const again = await createKey(ada)
    expect((await box.redeem(again.key, 'Other name')).type).toBe('enroll.redeemed')
    const [relinked] = await machinesOf(ada)
    expect(relinked).toMatchObject({ machineId: box.machineId, name: 'Build box', createdAt: linked?.createdAt })
    expect(Date.parse(relinked?.lastOpenedAt ?? '')).toBeGreaterThan(Date.parse(linked?.lastOpenedAt ?? ''))

    const secrets = [created.key, hashEnrollmentKey(created.key), ada.email, ada.name]
    const seen = [...lookups, ...logs.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')))]
    expect(seen.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
    expect(box.raw.some((text) => text.includes(ada.email) || text.includes(created.key))).toBe(false)
  })

  test('unknown, used, expired and malformed keys all get the same invalid_key answer', async () => {
    const ada = await signedIn('Ada')
    const used = await createKey(ada)
    expect((await (await machine()).redeem(used.key, 'First')).type).toBe('enroll.redeemed')
    const expired = await createKey(ada)
    offsetMs = 15 * 60_000 + 1000

    const box = await machine()
    const answers: EnrollAnswer[] = []
    for (const key of [unknownKey(), used.key, expired.key, 'oek_short', '']) {
      answers.push(await box.preview(key), await box.redeem(key, 'Box'))
    }
    expect(answers.map(({ id: _, ...rest }) => rest)).toEqual(
      answers.map(() => ({ type: 'enroll.failed', code: 'invalid_key' })),
    )
    expect((await enrollmentRow(expired.key))?.usedAt).toBeNull()
    expect((await machinesOf(ada)).map((m) => m.machineId)).not.toContain(box.machineId)
  })

  test('two machines redeeming one key at once get exactly one success', async () => {
    const ada = await signedIn('Ada')
    const { key } = await createKey(ada)
    const [one, two] = [await machine(), await machine()]
    const answers = await Promise.all([one.redeem(key, 'One'), two.redeem(key, 'Two')])
    expect(answers.map((answer) => answer.type).sort()).toEqual(['enroll.failed', 'enroll.redeemed'])
    const winner = answers[0]?.type === 'enroll.redeemed' ? one : two
    expect((await machinesOf(ada)).map((m) => m.machineId)).toEqual([winner.machineId])
  })

  test('a machine out of enrollment tokens is refused before any lookup, and another machine is still admitted', async () => {
    const box = await machine()
    for (let i = 0; i < 10; i++) expect(await box.preview(unknownKey())).toMatchObject({ code: 'invalid_key' })
    const before = lookups.length
    expect(await box.preview(unknownKey())).toEqual({ type: 'enroll.failed', id: 11, code: 'rate_limited' })
    expect(await box.redeem(unknownKey(), 'Box')).toEqual({ type: 'enroll.failed', id: 12, code: 'rate_limited' })
    expect(lookups.length).toBe(before)

    // Same IP, another machine: the bucket is per machine id.
    expect(await (await machine()).preview(unknownKey())).toMatchObject({ code: 'invalid_key' })
  })
})
