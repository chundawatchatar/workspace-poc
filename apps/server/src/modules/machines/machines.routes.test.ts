import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import type { ServerMachine } from '@orch/shared'
import { eq } from 'drizzle-orm'
import { accountsTestApp, cookiePair } from '../auth/auth.testing'
import { type MachineConnection, machineIdFromProof } from '../tunnel/tunnel.service'
import { MachinesService } from './machines.service'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = accountsTestApp(domain, '10.5.0')
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

async function link(user: User, machineId: string, name: string) {
  return ctx.client.call('POST', '/api/machines', { ...user, body: { machineId, name } })
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
  test('linking again keeps the name and refreshes `lastOpenedAt`; another user gets their own row', async () => {
    const ada = await signedIn()
    const machineId = freshMachineId()
    const before = Date.now()
    const first = await link(ada, machineId, '  Laptop  ')
    expect(first.status).toBe(200)
    const machine = (await first.json()) as ServerMachine
    expect(machine).toMatchObject({ machineId, name: 'Laptop', online: false })
    expect(machine.createdAt).toBe(machine.lastOpenedAt)
    expect(Date.parse(machine.createdAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(Object.keys(machine).sort()).toEqual(['createdAt', 'lastOpenedAt', 'machineId', 'name', 'online'])

    await Bun.sleep(5)
    const again = (await (await link(ada, machineId, 'Other name')).json()) as ServerMachine
    expect(again).toMatchObject({ machineId, name: 'Laptop', createdAt: machine.createdAt })
    expect(Date.parse(again.lastOpenedAt)).toBeGreaterThan(Date.parse(machine.lastOpenedAt))

    const bob = await signedIn()
    expect(await (await link(bob, machineId, 'Bob box')).json()).toMatchObject({ machineId, name: 'Bob box' })
    const rows = await rowsOf(machineId)
    expect(rows.map((row) => [row.userId, row.name]).sort()).toEqual(
      [
        [ada.userId, 'Laptop'],
        [bob.userId, 'Bob box'],
      ].sort(),
    )
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
    const key = `secret-key-${randomUUID()}`
    const bad = [
      { machineId: 'too-short', name: 'Laptop' },
      { machineId, name: '   ' },
      { machineId, name: 'x'.repeat(65) },
      { machineId, name: 'Laptop', key },
    ]
    for (const body of bad) {
      const response = await ctx.client.call('POST', '/api/machines', { ...ada, body })
      expect(response.status).toBe(400)
      expect(await response.text()).not.toContain(key)
    }
    const renameWithKey = await ctx.client.call('PATCH', path(machineId), { ...ada, body: { name: 'X', key } })
    expect(renameWithKey.status).toBe(400)
    expect(await rowsOf(machineId)).toEqual([])

    const anonymous = { ip: ada.ip }
    for (const [method, url] of [
      ['GET', '/api/machines'],
      ['POST', '/api/machines'],
      ['PATCH', path(machineId)],
      ['DELETE', path(machineId)],
    ] as const) {
      const body = method === 'GET' ? undefined : { machineId, name: 'Laptop' }
      expect(await errorOf(await ctx.client.call(method, url, { ...anonymous, body }))).toEqual({
        status: 401,
        code: 'unauthorized',
      })
    }

    const body = { machineId, name: 'Laptop' }
    const evil = await ctx.client.call('POST', '/api/machines', { ...ada, body, origin: 'https://evil.example' })
    expect(await errorOf(evil)).toEqual({ status: 403, code: 'forbidden_origin' })
    const plain = await ctx.client.call('POST', '/api/machines', {
      ...ada,
      body,
      headers: { 'content-type': 'text/plain' },
    })
    expect(await errorOf(plain)).toEqual({ status: 415, code: 'unsupported_media_type' })
    expect(await rowsOf(machineId)).toEqual([])
  })
})
