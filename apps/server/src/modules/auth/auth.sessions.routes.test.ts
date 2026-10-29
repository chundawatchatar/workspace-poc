import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import { accountsTestApp } from './auth.testing'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = accountsTestApp(domain, '10.3.0')
})

afterAll(async () => {
  await domain.close()
})

interface Device {
  email: string
  cookie: string
  ip: string
}

/** A fresh verified user signed in `count` times, each from its own IP, as one browser per session. */
async function userWithSessions(count: number): Promise<Device[]> {
  const email = ctx.client.freshEmail()
  await ctx.client.register(email, ctx.client.freshIp())
  const devices: Device[] = []
  while (devices.length < count) {
    const ip = ctx.client.freshIp()
    devices.push({ email, ip, cookie: await ctx.client.signIn(email, ip) })
  }
  return devices
}

async function listSessions({ cookie, ip }: Device) {
  const response = await ctx.client.call('GET', '/api/auth/list-sessions', { ip, cookie })
  expect(response.status).toBe(200)
  return (await response.json()) as { token: string; userId: string; ipAddress: string }[]
}

/** The token of the session behind `device`, read from `list-sessions` as a client would. */
async function tokenOf(device: Device): Promise<string> {
  const sessions = await listSessions(device)
  const session = sessions.find((s) => s.ipAddress === device.ip)
  if (!session) throw new Error('no session from that IP')
  return session.token
}

/** Whether `device` is still signed in, asked of both `/api/me` and Better Auth's `get-session`, which must agree. */
async function signedIn({ cookie, ip }: Device): Promise<boolean> {
  const me = await ctx.client.call('GET', '/api/me', { ip, cookie })
  const session = await ctx.client.call('GET', '/api/auth/get-session', { ip, cookie })
  const body = (await session.json()) as { user?: unknown } | null
  if (me.status === 401) {
    expect(((await me.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
    expect(body).toBeNull()
    return false
  }
  expect(me.status).toBe(200)
  expect(body?.user).toBeDefined()
  return true
}

describe('session endpoints', () => {
  test('`list-sessions` answers every session of the signed-in user and no one else', async () => {
    const [a, b] = await userWithSessions(2)
    const [other] = await userWithSessions(1)
    const sessions = await listSessions(a as Device)
    expect(sessions).toHaveLength(2)
    expect(new Set(sessions.map((s) => s.userId)).size).toBe(1)
    expect(sessions.map((s) => s.ipAddress).sort()).toEqual([a?.ip, b?.ip].sort() as string[])
    expect(sessions.map((s) => s.token)).not.toContain(await tokenOf(other as Device))

    const anonymous = await ctx.client.call('GET', '/api/auth/list-sessions', { ip: ctx.client.freshIp() })
    expect(anonymous.status).toBe(401)
  })

  test('`revoke-session` ends that session on its next request, and only within the same user', async () => {
    const [a, b] = (await userWithSessions(2)) as [Device, Device]
    const [other] = (await userWithSessions(1)) as [Device]

    const revoke = await ctx.client.call('POST', '/api/auth/revoke-session', {
      ...a,
      body: { token: await tokenOf(b) },
    })
    expect(revoke.status).toBe(200)
    expect(await signedIn(b)).toBe(false)
    expect(await signedIn(a)).toBe(true)

    await ctx.client.call('POST', '/api/auth/revoke-session', { ...a, body: { token: await tokenOf(other) } })
    expect(await signedIn(other)).toBe(true)
  })

  test('`revoke-other-sessions` keeps the caller, `revoke-sessions` ends every one', async () => {
    const [a, b, c] = (await userWithSessions(3)) as [Device, Device, Device]
    expect((await ctx.client.call('POST', '/api/auth/revoke-other-sessions', a)).status).toBe(200)
    expect(await signedIn(b)).toBe(false)
    expect(await signedIn(c)).toBe(false)
    expect(await signedIn(a)).toBe(true)

    const all = (await userWithSessions(3)) as Device[]
    expect((await ctx.client.call('POST', '/api/auth/revoke-sessions', all[0] as Device)).status).toBe(200)
    for (const device of all) expect(await signedIn(device)).toBe(false)
  })

  test('a revoke from an untrusted origin is refused and every session survives', async () => {
    const devices = (await userWithSessions(2)) as [Device, Device]
    const origin = 'https://evil.example'
    const others = await ctx.client.call('POST', '/api/auth/revoke-other-sessions', { ...devices[0], origin })
    expect(others.status).toBe(403)
    const all = await ctx.client.call('POST', '/api/auth/revoke-sessions', { ...devices[0], origin })
    expect(all.status).toBe(403)
    for (const device of devices) expect(await signedIn(device)).toBe(true)
  })
})
