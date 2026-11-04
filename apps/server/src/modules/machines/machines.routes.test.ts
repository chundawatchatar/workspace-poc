import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import {
  type CreateEnrollmentResponse,
  enrollmentKeySchema,
  type RelayTicketResponse,
  type ServerMachine,
} from '@orch/shared'
import { eq } from 'drizzle-orm'
import { accountsTestApp, cookiePair } from '../auth/auth.testing'
import { type MachineConnection, machineIdFromProof } from '../tunnel/tunnel.service'
import { MachinesService } from './machines.service'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>
const NOW = new Date('2026-03-01T12:00:00.000Z')

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = accountsTestApp(domain, '10.5.0', { now: () => NOW })
})

afterAll(async () => {
  await domain.close()
})

interface User {
  userId: string
  ip: string
  cookie: string
}

/** A fresh verified user, signed in from their own IP. */
async function signedIn(): Promise<User> {
  const email = ctx.client.freshEmail()
  const ip = ctx.client.freshIp()
  const cookie = cookiePair(await ctx.client.verifiedUser(email, ip))
  const [row] = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
  return { userId: row?.id as string, ip, cookie }
}

const freshMachineId = () => machineIdFromProof(randomUUID())
const path = (machineId: string) => `/api/machines/${machineId}`

/** Links `machineId` to `user` the way redeeming an enrollment key does, without HTTP. */
function link(user: User, machineId: string, name: string) {
  return new MachinesService(domain.forUser({ userId: user.userId }).machines, ctx.registry).link(machineId, name)
}

async function list(user: User): Promise<ServerMachine[]> {
  const response = await ctx.client.call('GET', '/api/machines', user)
  expect(response.status).toBe(200)
  return ((await response.json()) as { machines: ServerMachine[] }).machines
}

/** Every stored row for `machineId`, whoever owns it. */
function rowsOf(machineId: string) {
  return domain
    .skipAuthorization('test: read rows across users')
    .select()
    .from(schema.machines)
    .where(eq(schema.machines.machineId, machineId))
}

async function errorOf(response: Response) {
  return { status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }
}

describe('machines module', () => {
  test('has no endpoint that links a machine by id: `POST /api/machines` answers 404 and writes nothing', async () => {
    const ada = await signedIn()
    const machineId = freshMachineId()
    const response = await ctx.client.call('POST', '/api/machines', { ...ada, body: { machineId, name: 'Laptop' } })
    expect(await errorOf(response)).toEqual({ status: 404, code: 'not_found' })
    expect(await rowsOf(machineId)).toEqual([])
    expect(await list(ada)).toEqual([])
  })

  test('signs a relay ticket only for a machine the caller lists, and only for a signed-in caller', async () => {
    const ada = await signedIn()
    const bob = await signedIn()
    const machineId = freshMachineId()
    await link(ada, machineId, 'Box')
    const ticketOf = (user: User | Omit<User, 'cookie'>) =>
      ctx.client.call('POST', `${path(machineId)}/relay-ticket`, { ...user, body: {} })

    const issued = await ticketOf(ada)
    expect(issued.status).toBe(200)
    const { ticket, expiresAt } = (await issued.json()) as RelayTicketResponse
    expect(expiresAt).toBe(new Date(NOW.getTime() + 60_000).toISOString())
    const [header = '', payload = '', signature = ''] = ticket.split('.')
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())
    const [key] = ctx.relayTickets.publicKeys
    expect(decode(header)).toEqual({ alg: 'EdDSA', typ: 'orch-relay', kid: key?.kid })
    expect(decode(payload)).toEqual({
      sub: ada.userId,
      aud: machineId,
      exp: NOW.getTime() / 1000 + 60,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    })
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key?.publicKey ?? '' },
      format: 'jwk',
    })
    const signed = Buffer.from(`${header}.${payload}`)
    expect(verify(null, signed, publicKey, Buffer.from(signature, 'base64url'))).toBe(true)

    // Bob doesn't list the machine, and nobody signed in gets nothing either.
    expect(await errorOf(await ticketOf(bob))).toEqual({ status: 404, code: 'not_found' })
    const { cookie: _, ...signedOut } = ada
    expect((await ticketOf(signedOut)).status).toBe(401)
  })

  test('a link that loses a race to the unique index returns the row that won', async () => {
    const ada = await signedIn()
    const machineId = freshMachineId()
    const machines = domain.forUser({ userId: ada.userId }).machines
    await machines.insert({ machineId, name: 'Won', lastOpenedAt: new Date(0) })
    // The first lookup misses, as if the other request's insert landed just after it.
    let lookups = 0
    const racing = {
      ...machines,
      update: async (...args: Parameters<typeof machines.update>) => {
        return lookups++ === 0 ? [] : machines.update(...args)
      },
    }
    const machine = await new MachinesService(racing, ctx.registry).link(machineId, 'Lost')
    expect(machine).toMatchObject({ machineId, name: 'Won' })
    expect(await rowsOf(machineId)).toHaveLength(1)
  })

  test("lists only the caller's machines, newest first, online exactly while the registry holds them", async () => {
    const ada = await signedIn()
    const bob = await signedIn()
    const [older, newer, bobs] = [freshMachineId(), freshMachineId(), freshMachineId()]
    await link(ada, older, 'Older')
    await Bun.sleep(5)
    await link(ada, newer, 'Newer')
    await link(bob, bobs, 'Bob box')
    expect((await list(ada)).map((m) => [m.name, m.online])).toEqual([
      ['Newer', false],
      ['Older', false],
    ])

    const conn: MachineConnection = { machineId: older, send: () => {}, close: () => {} }
    ctx.registry.register(conn)
    expect((await list(ada)).find((m) => m.machineId === older)?.online).toBe(true)
    ctx.registry.remove(conn)
    expect((await list(ada)).find((m) => m.machineId === older)?.online).toBe(false)
  })

  test("renames and unlinks the caller's machine, and answers 404 for one only another user linked", async () => {
    const ada = await signedIn()
    const bob = await signedIn()
    const mine = freshMachineId()
    const bobs = freshMachineId()
    await link(ada, mine, 'Laptop')
    await link(bob, bobs, 'Bob box')

    const renamed = await ctx.client.call('PATCH', path(mine), { ...ada, body: { name: 'Desk' } })
    expect(await renamed.json()).toMatchObject({ machineId: mine, name: 'Desk' })

    for (const machineId of [bobs, freshMachineId()]) {
      const rename = await ctx.client.call('PATCH', path(machineId), { ...ada, body: { name: 'Mine now' } })
      expect(await errorOf(rename)).toEqual({ status: 404, code: 'not_found' })
      expect(await errorOf(await ctx.client.call('DELETE', path(machineId), { ...ada, body: {} }))).toEqual({
        status: 404,
        code: 'not_found',
      })
    }
    expect(await rowsOf(bobs)).toMatchObject([{ userId: bob.userId, name: 'Bob box' }])

    const unlinked = await ctx.client.call('DELETE', path(mine), { ...ada, body: {} })
    expect(unlinked.status).toBe(200)
    expect(await unlinked.json()).toEqual({ ok: true })
    expect(await rowsOf(mine)).toEqual([])
  })

  test('refuses bad input, a key, no session, a foreign origin and a non-JSON body before writing', async () => {
    const ada = await signedIn()
    const machineId = freshMachineId()
    await link(ada, machineId, 'Laptop')
    const key = `secret-key-${randomUUID()}`
    const bad = [
      { url: path('too-short'), body: { name: 'Desk' } },
      { url: path(machineId), body: { name: '   ' } },
      { url: path(machineId), body: { name: 'x'.repeat(65) } },
      { url: path(machineId), body: { name: 'Desk', key } },
    ]
    for (const { url, body } of bad) {
      const response = await ctx.client.call('PATCH', url, { ...ada, body })
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain(key)
    }

    const anonymous = { ip: ada.ip }
    for (const [method, url] of [
      ['GET', '/api/machines'],
      ['PATCH', path(machineId)],
      ['DELETE', path(machineId)],
    ] as const) {
      const body = method === 'GET' ? undefined : { name: 'Desk' }
      expect(await errorOf(await ctx.client.call(method, url, { ...anonymous, body }))).toEqual({
        status: 401,
        code: 'unauthorized',
      })
    }

    const body = { name: 'Desk' }
    const evil = await ctx.client.call('PATCH', path(machineId), { ...ada, body, origin: 'https://evil.example' })
    expect(await errorOf(evil)).toEqual({ status: 403, code: 'forbidden_origin' })
    const plain = await ctx.client.call('PATCH', path(machineId), {
      ...ada,
      body,
      headers: { 'content-type': 'text/plain' },
    })
    expect(await errorOf(plain)).toEqual({ status: 415, code: 'unsupported_media_type' })
    expect(await rowsOf(machineId)).toMatchObject([{ userId: ada.userId, name: 'Laptop' }])
  })

  test('creates an enrollment key that only its hash is stored for, and refuses a body or no session', async () => {
    const ada = await signedIn()
    const create = (body: unknown, user: Partial<User> = ada) =>
      ctx.client.call('POST', '/api/machines/enrollments', { ip: ada.ip, ...user, body })
    const response = await create({})
    expect(response.status).toBe(200)
    const created = (await response.json()) as CreateEnrollmentResponse
    expect(enrollmentKeySchema.safeParse(created.key).success).toBe(true)
    expect(Buffer.from(created.key.slice('oek_'.length), 'base64url')).toHaveLength(32)
    expect(created.fingerprint).toBe(created.key.slice(-4))
    expect(created.expiresAt).toBe(new Date(NOW.getTime() + 15 * 60_000).toISOString())
    const other = (await (await create({})).json()) as CreateEnrollmentResponse
    expect(other.key).not.toBe(created.key)

    const enrollmentsOf = () =>
      domain
        .skipAuthorization('test: read enrollment rows')
        .select()
        .from(schema.machineEnrollments)
        .where(eq(schema.machineEnrollments.userId, ada.userId))
    const rows = await enrollmentsOf()
    expect(rows).toHaveLength(2)
    const row = rows.find((r) => r.keyHash === createHash('sha256').update(created.key).digest('hex'))
    expect(row).toMatchObject({ createdAt: NOW, usedAt: null })
    expect(Object.values(row ?? {})).not.toContain(created.key)

    for (const body of [{ key: created.key }, { name: 'Laptop' }]) {
      expect(await errorOf(await create(body))).toEqual({ status: 400, code: 'bad_request' })
    }
    expect(await errorOf(await create({}, { cookie: undefined }))).toEqual({ status: 401, code: 'unauthorized' })
    expect(await enrollmentsOf()).toHaveLength(2)
  })
})
