import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { createApp } from '../../app'
import { clientIpReader } from '../../lib/clientIp'
import { ChannelBridge } from '../bridge/bridge.service'
import { HttpForwarder } from '../forward/forward.service'
import { ConnectionLimiter } from '../limits/limits.service'
import { createMailer } from '../mailer/mailer.service'
import { type CaptureTransport, createCaptureTransport } from '../mailer/mailer.testing'
import { MachineRegistry } from '../tunnel/tunnel.service'
import { createAuthModule } from './auth.routes'
import { createAuth } from './auth.service'
import { authTestClient, cookiePair, sessionSetCookie, TEST_PASSWORD } from './auth.testing'

const BASE = 'http://orch.example'
const TRUSTED = 'https://app.example'

let domain: TestDomain
let mail: CaptureTransport
let app: Hono
let client: ReturnType<typeof authTestClient>
const logLines: string[] = []
const originalConsole = { log: console.log, warn: console.warn, error: console.error }

beforeAll(async () => {
  // Kept instead of printed, so the last test can check that nothing secret was logged.
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => void logLines.push(args.map(String).join(' '))
  }
  domain = await createTestDomain()
  mail = createCaptureTransport()
  const auth = createAuth({
    domain,
    mailer: createMailer({ transport: mail.transport, from: 'Orch <no-reply@orch.example>' }),
    secret: 'a-test-secret-that-is-at-least-32-bytes-long',
    baseUrl: BASE,
    trustedOrigins: [TRUSTED],
  })
  const registry = new MachineRegistry()
  app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(),
    accounts: { modules: [createAuthModule({ auth, clientIp: clientIpReader({ trustProxy: false }) })] },
  })
  client = authTestClient({ app, mail, base: BASE, ipPrefix: '10.0.0' })
})

afterAll(async () => {
  Object.assign(console, originalConsole)
  await domain.close()
})

/** RFC 6265 section 5.1.4: whether a cookie with `cookiePath` is sent with a request for `requestPath`. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

async function sessionEmail(cookie: string, ip: string): Promise<string | null> {
  const response = await client.call('GET', '/api/auth/get-session', { ip, cookie })
  const body = (await response.json()) as { user?: { email: string } } | null
  return body?.user?.email ?? null
}

describe('auth module', () => {
  test('sign-up sends one verification email and allows sign-in only after the link is followed', async () => {
    const email = client.freshEmail()
    const ip = client.freshIp()
    const signUp = await client.call('POST', '/api/auth/sign-up/email', {
      ip,
      body: { email, password: TEST_PASSWORD, name: 'A' },
    })
    expect(signUp.status).toBe(200)
    expect(sessionSetCookie(signUp)).toBeUndefined()
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(1)

    const early = await client.call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: TEST_PASSWORD } })
    expect(early.status).toBe(403)

    const link = client.linkTo(email, 'verifyEmail')
    expect(link.pathname).toBe('/api/auth/verify-email')
    const verify = await client.call('GET', `${link.pathname}${link.search}`, { ip })
    expect(verify.status).toBeLessThan(400)

    const signIn = await client.call('POST', '/api/auth/sign-in/email', {
      ip,
      body: { email, password: TEST_PASSWORD },
    })
    expect(signIn.status).toBe(200)
    expect(sessionSetCookie(signIn)).toBeDefined()
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(1)
  })

  test('the session cookie is scoped to `/api`, so a browser never sends it to a relayed machine', async () => {
    const email = client.freshEmail()
    const ip = client.freshIp()
    const setCookie = await client.verifiedUser(email, ip)
    const attributes = setCookie.split(';').map((part) => part.trim().toLowerCase())
    expect(attributes).toContain('path=/api')
    expect(attributes).toContain('httponly')
    expect(attributes).toContain('secure')
    expect(attributes).toContain('samesite=lax')

    expect(await sessionEmail(cookiePair(setCookie), ip)).toBe(email)
    expect(pathMatches('/api', '/api/auth/get-session')).toBe(true)
    expect(pathMatches('/api', '/m/abc123/api/health')).toBe(false)
    expect(pathMatches('/api', '/apix')).toBe(false)
  })

  test('sign-out expires the cookie on the same path and ends the session', async () => {
    const email = client.freshEmail()
    const ip = client.freshIp()
    const cookie = cookiePair(await client.verifiedUser(email, ip))
    const signOut = await client.call('POST', '/api/auth/sign-out', { ip, cookie })
    expect(signOut.status).toBe(200)
    const expired = (sessionSetCookie(signOut) as string).toLowerCase()
    expect(expired).toContain('path=/api')
    expect(expired).toContain('max-age=0')
    expect(await sessionEmail(cookie, ip)).toBeNull()
  })

  test('a password reset ends existing sessions at once and swaps the password', async () => {
    const email = client.freshEmail()
    const ip = client.freshIp()
    const before = cookiePair(await client.verifiedUser(email, ip))
    expect(await sessionEmail(before, ip)).toBe(email)

    const request = await client.call('POST', '/api/auth/request-password-reset', { ip, body: { email } })
    expect(request.status).toBe(200)
    const resets = mail.sent.filter((m) => m.to === email && m.subject === 'Reset your password')
    expect(resets).toHaveLength(1)
    const link = client.linkTo(email, 'resetPassword')
    const token = link.pathname.split('/').at(-1)
    expect(link.pathname).toBe(`/api/auth/reset-password/${token}`)

    const newPassword = 'a brand new passphrase'
    const reset = await client.call('POST', '/api/auth/reset-password', { ip, body: { token, newPassword } })
    expect(reset.status).toBe(200)
    expect(await sessionEmail(before, ip)).toBeNull()

    const old = await client.call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: TEST_PASSWORD } })
    expect(old.status).toBe(401)
    const fresh = await client.call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: newPassword } })
    expect(fresh.status).toBe(200)
  })

  test('sign-in is rate limited per socket IP, whatever `X-Forwarded-For` says', async () => {
    const attacker = client.freshIp()
    const victim = client.freshIp()
    const body = { email: client.freshEmail(), password: TEST_PASSWORD }
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const headers = { 'x-forwarded-for': i % 2 === 0 ? victim : `192.0.2.${i}` }
      statuses.push((await client.call('POST', '/api/auth/sign-in/email', { ip: attacker, body, headers })).status)
    }
    expect(statuses.slice(0, 3)).not.toContain(429)
    expect(statuses[3]).toBe(429)
    expect((await client.call('POST', '/api/auth/sign-in/email', { ip: victim, body })).status).not.toBe(429)
  })

  test('a POST from an untrusted origin is refused, and one from a trusted origin is accepted', async () => {
    const body = { email: client.freshEmail(), password: TEST_PASSWORD }
    const evil = await client.call('POST', '/api/auth/sign-in/email', {
      ip: client.freshIp(),
      body,
      origin: 'https://evil.example',
    })
    expect(evil.status).toBe(403)
    const trusted = await client.call('POST', '/api/auth/sign-in/email', {
      ip: client.freshIp(),
      body,
      origin: TRUSTED,
    })
    expect(trusted.status).toBe(401)
  })

  test('signing up with a registered email looks like a new sign-up and changes nothing', async () => {
    const email = client.freshEmail()
    const first = await client.call('POST', '/api/auth/sign-up/email', {
      ip: client.freshIp(),
      body: { email, password: TEST_PASSWORD, name: 'A' },
    })
    const again = await client.call('POST', '/api/auth/sign-up/email', {
      ip: client.freshIp(),
      body: { email, password: 'another password', name: 'B' },
    })
    expect(again.status).toBe(first.status)
    expect(again.headers.getSetCookie()).toEqual(first.headers.getSetCookie())
    const firstBody = (await first.json()) as { token: unknown; user: Record<string, unknown> }
    const againBody = (await again.json()) as { token: unknown; user: Record<string, unknown>; code?: string }
    expect(againBody.code).toBeUndefined()
    expect(againBody.token).toBe(firstBody.token)
    expect(Object.keys(againBody.user).sort()).toEqual(Object.keys(firstBody.user).sort())

    const rows = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
    expect(rows).toHaveLength(1)
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(1)
  })

  // Runs last, after every flow above has logged what it logs.
  test('no log line holds an email address, a token or a link', () => {
    const secrets = new Set<string>()
    for (const message of mail.sent) {
      secrets.add(message.to)
      const url = new URL(message.text.match(/https?:\/\/\S+/)?.[0] as string)
      secrets.add(url.href)
      secrets.add(`${url.pathname}${url.search}`)
      const token = url.searchParams.get('token') ?? url.pathname.split('/').at(-1)
      if (token) secrets.add(token)
    }
    expect(secrets.size).toBeGreaterThan(0)
    for (const line of logLines) {
      expect(line).not.toContain('@test.example')
      for (const secret of secrets) expect(line).not.toContain(secret)
    }
  })
})
