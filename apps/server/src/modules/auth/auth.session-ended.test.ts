import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import { eq } from 'drizzle-orm'
import { accountsTestApp } from './auth.testing'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>
/** The user ids `onSessionEnded` was told, in order. */
let ended: string[] = []
/** What the callback does after recording, so a test can make it throw or reject. */
let behave: () => unknown = () => {}

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = accountsTestApp(domain, '10.9.0', {
    onSessionEnded: (userId) => {
      ended.push(userId)
      return behave()
    },
  })
})

afterEach(() => {
  ended = []
  behave = () => {}
  mock.restore()
})

afterAll(async () => {
  await domain.close()
})

interface Device {
  cookie: string
  ip: string
}

/** A fresh verified user signed in `count` times, each from its own IP, with the user's id. */
async function userWithSessions(count: number): Promise<{ userId: string; devices: Device[] }> {
  const email = ctx.client.freshEmail()
  await ctx.client.register(email, ctx.client.freshIp())
  // Registering signs out of the sign-up's own session, which this callback was told about.
  ended = []
  const devices: Device[] = []
  while (devices.length < count) {
    const ip = ctx.client.freshIp()
    devices.push({ ip, cookie: await ctx.client.signIn(email, ip) })
  }
  const [row] = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
  return { userId: row?.id ?? '', devices }
}

async function tokenOf(caller: Device, of: Device): Promise<string> {
  const response = await ctx.client.call('GET', '/api/auth/list-sessions', caller)
  const sessions = (await response.json()) as { token: string; ipAddress: string }[]
  return sessions.find((s) => s.ipAddress === of.ip)?.token ?? ''
}

async function signedIn(device: Device): Promise<boolean> {
  return (await ctx.client.call('GET', '/api/me', device)).status === 200
}

describe('onSessionEnded', () => {
  test('every way of ending a session tells it the signed-in user, once per ended session', async () => {
    const one = await userWithSessions(3)
    const [a, b, c] = one.devices as [Device, Device, Device]
    const token = await tokenOf(a, b)
    expect((await ctx.client.call('POST', '/api/auth/revoke-session', { ...a, body: { token } })).status).toBe(200)
    expect(ended).toEqual([one.userId])

    ended = []
    expect((await ctx.client.call('POST', '/api/auth/revoke-other-sessions', a)).status).toBe(200)
    expect(ended).toEqual([one.userId])
    expect(await signedIn(c)).toBe(false)

    ended = []
    expect((await ctx.client.call('POST', '/api/auth/sign-out', a)).status).toBe(200)
    expect(ended).toEqual([one.userId])

    const two = await userWithSessions(2)
    ended = []
    expect((await ctx.client.call('POST', '/api/auth/revoke-sessions', two.devices[0] as Device)).status).toBe(200)
    expect(ended).toEqual([two.userId, two.userId])
  })

  test('a callback that throws or rejects still lets the revoke answer 200 and end the session', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    for (const failing of [
      () => {
        throw new Error('boom')
      },
      () => Promise.reject(new Error('boom')),
    ]) {
      behave = failing
      const { userId, devices } = await userWithSessions(2)
      const [a, b] = devices as [Device, Device]
      expect((await ctx.client.call('POST', '/api/auth/revoke-sessions', a)).status).toBe(200)
      expect(await signedIn(a)).toBe(false)
      expect(await signedIn(b)).toBe(false)
      expect(ended.at(-1)).toBe(userId)
    }
    await Bun.sleep(0)
    // Only the fixed line, never the user id.
    expect(errors.mock.calls.map((call) => call.join(' '))).toEqual(
      errors.mock.calls.map(() => 'auth: telling machines that a session ended failed'),
    )
    expect(errors.mock.calls.length).toBeGreaterThan(0)
  })
})
