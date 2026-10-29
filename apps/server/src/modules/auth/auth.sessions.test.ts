import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import { revokeUserSessions } from './auth.sessions'
import { accountsTestApp, cookiePair } from './auth.testing'

let domain: TestDomain
let ctx: ReturnType<typeof accountsTestApp>
const db = () => domain.skipAuthorization('test: operator revocation')

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = accountsTestApp(domain, '10.4.0')
})

afterAll(async () => {
  await domain.close()
})

async function meStatus(cookie: string, ip: string): Promise<number> {
  return (await ctx.client.call('GET', '/api/me', { ip, cookie })).status
}

describe('revokeUserSessions', () => {
  test('deletes every session of the user, matching the email in any case, and no one else', async () => {
    const email = ctx.client.freshEmail()
    const ip1 = ctx.client.freshIp()
    const ip2 = ctx.client.freshIp()
    await ctx.client.register(email, ip1)
    const first = await ctx.client.signIn(email, ip1)
    const second = await ctx.client.signIn(email, ip2)
    const bystanderIp = ctx.client.freshIp()
    const bystander = cookiePair(await ctx.client.verifiedUser(ctx.client.freshEmail(), bystanderIp))

    const logged: unknown[] = []
    const original = { log: console.log, warn: console.warn, error: console.error }
    for (const level of ['log', 'warn', 'error'] as const) console[level] = (...args) => void logged.push(...args)
    try {
      expect(await revokeUserSessions(db(), `  ${email.toUpperCase()} `)).toEqual({ found: true, revoked: 2 })
    } finally {
      Object.assign(console, original)
    }
    expect(logged).toEqual([])

    expect(await meStatus(first, ip1)).toBe(401)
    expect(await meStatus(second, ip2)).toBe(401)
    expect(await meStatus(bystander, bystanderIp)).toBe(200)
  })

  test('an unknown email finds no user and deletes nothing', async () => {
    await ctx.client.verifiedUser(ctx.client.freshEmail(), ctx.client.freshIp())
    const before = await db().select().from(schema.session)
    expect(before.length).toBeGreaterThan(0)
    expect(await revokeUserSessions(db(), 'nobody@test.example')).toEqual({ found: false, revoked: 0 })
    expect(await db().select().from(schema.session)).toEqual(before)
  })
})
