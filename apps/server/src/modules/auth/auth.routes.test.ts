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

const BASE = 'http://orch.example'
const TRUSTED = 'https://app.example'
const PASSWORD = 'correct horse battery'
const SESSION_COOKIE = 'better-auth.session_token'

let domain: TestDomain
let mail: CaptureTransport
let app: Hono
const logLines: string[] = []
const originalConsole = { log: console.log, warn: console.warn, error: console.error }

// Better Auth keeps its rate-limit counters in one in-memory store per process, so every scenario gets its own IP.
let nextIp = 1
const freshIp = () => `10.0.0.${nextIp++}`
let nextEmail = 1
const freshEmail = () => `user${nextEmail++}@test.example`

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
})

afterAll(async () => {
  Object.assign(console, originalConsole)
  await domain.close()
})

interface CallOptions {
  /** The socket address the request comes from. */
  ip: string
  body?: unknown
  cookie?: string
  /** Defaults to the server's own origin on a POST. */
  origin?: string
  headers?: Record<string, string>
}

function call(method: 'GET' | 'POST', path: string, { ip, body, cookie, origin, headers = {} }: CallOptions) {
  const server = { upgrade: () => false, requestIP: () => ({ address: ip, family: 'IPv4', port: 40000 }) }
  const init: RequestInit = { method, headers: { ...headers } }
  const h = init.headers as Record<string, string>
  if (cookie) h.cookie = cookie
  if (method === 'POST') {
    h.origin = origin ?? BASE
    h['content-type'] = 'application/json'
    init.body = JSON.stringify(body ?? {})
  }
  return app.request(`${BASE}${path}`, init, server)
}

/** The session cookie a response sets, with its attributes, or undefined when it sets none. */
function sessionSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`))
}

/** The `name=value` pair a browser would send back for a `Set-Cookie` line. */
const cookiePair = (setCookie: string) => setCookie.split(';')[0] as string

/** The link in the last email of `template` sent to `address`. */
function linkTo(address: string, template: 'verifyEmail' | 'resetPassword'): URL {
  const subject = template === 'verifyEmail' ? 'Verify your email address' : 'Reset your password'
  const message = mail.sent.filter((m) => m.to === address && m.subject === subject).at(-1)
  const url = message?.text.match(/https?:\/\/\S+/)?.[0]
  if (!url) throw new Error(`no ${template} link for the address`)
  return new URL(url)
}

/** RFC 6265 section 5.1.4: whether a cookie with `cookiePath` is sent with a request for `requestPath`. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/** Signs up, follows the verification link and signs in, returning the session cookie line. */
async function verifiedUser(email: string, ip: string) {
  await call('POST', '/api/auth/sign-up/email', { ip, body: { email, password: PASSWORD, name: 'Test' } })
  const link = linkTo(email, 'verifyEmail')
  await call('GET', `${link.pathname}${link.search}`, { ip })
  const signIn = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: PASSWORD } })
  expect(signIn.status).toBe(200)
  return sessionSetCookie(signIn) as string
}

async function sessionEmail(cookie: string, ip: string): Promise<string | null> {
  const response = await call('GET', '/api/auth/get-session', { ip, cookie })
  const body = (await response.json()) as { user?: { email: string } } | null
  return body?.user?.email ?? null
}

describe('auth module', () => {
  test('sign-up sends one verification email and allows sign-in only after the link is followed', async () => {
    const email = freshEmail()
    const ip = freshIp()
    const signUp = await call('POST', '/api/auth/sign-up/email', { ip, body: { email, password: PASSWORD, name: 'A' } })
    expect(signUp.status).toBe(200)
    expect(sessionSetCookie(signUp)).toBeUndefined()
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(1)

    const early = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: PASSWORD } })
    expect(early.status).toBe(403)

    const link = linkTo(email, 'verifyEmail')
    expect(link.pathname).toBe('/api/auth/verify-email')
    const verify = await call('GET', `${link.pathname}${link.search}`, { ip })
    expect(verify.status).toBeLessThan(400)

    const signIn = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: PASSWORD } })
    expect(signIn.status).toBe(200)
    expect(sessionSetCookie(signIn)).toBeDefined()
    expect(mail.sent.filter((m) => m.to === email)).toHaveLength(1)
  })

  test('the session cookie is scoped to `/api`, so a browser never sends it to a relayed machine', async () => {
    const email = freshEmail()
    const ip = freshIp()
    const setCookie = await verifiedUser(email, ip)
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
    const email = freshEmail()
    const ip = freshIp()
    const cookie = cookiePair(await verifiedUser(email, ip))
    const signOut = await call('POST', '/api/auth/sign-out', { ip, cookie })
    expect(signOut.status).toBe(200)
    const expired = (sessionSetCookie(signOut) as string).toLowerCase()
    expect(expired).toContain('path=/api')
    expect(expired).toContain('max-age=0')
    expect(await sessionEmail(cookie, ip)).toBeNull()
  })

  test('a password reset ends existing sessions at once and swaps the password', async () => {
    const email = freshEmail()
    const ip = freshIp()
    const before = cookiePair(await verifiedUser(email, ip))
    expect(await sessionEmail(before, ip)).toBe(email)

    const request = await call('POST', '/api/auth/request-password-reset', { ip, body: { email } })
    expect(request.status).toBe(200)
    const resets = mail.sent.filter((m) => m.to === email && m.subject === 'Reset your password')
    expect(resets).toHaveLength(1)
    const link = linkTo(email, 'resetPassword')
    const token = link.pathname.split('/').at(-1)
    expect(link.pathname).toBe(`/api/auth/reset-password/${token}`)

    const newPassword = 'a brand new passphrase'
    const reset = await call('POST', '/api/auth/reset-password', { ip, body: { token, newPassword } })
    expect(reset.status).toBe(200)
    expect(await sessionEmail(before, ip)).toBeNull()

    const old = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: PASSWORD } })
    expect(old.status).toBe(401)
    const fresh = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: newPassword } })
    expect(fresh.status).toBe(200)
  })

  test('sign-in is rate limited per socket IP, whatever `X-Forwarded-For` says', async () => {
    const attacker = freshIp()
    const victim = freshIp()
    const body = { email: freshEmail(), password: PASSWORD }
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const headers = { 'x-forwarded-for': i % 2 === 0 ? victim : `192.0.2.${i}` }
      statuses.push((await call('POST', '/api/auth/sign-in/email', { ip: attacker, body, headers })).status)
    }
    expect(statuses.slice(0, 3)).not.toContain(429)
    expect(statuses[3]).toBe(429)
    expect((await call('POST', '/api/auth/sign-in/email', { ip: victim, body })).status).not.toBe(429)
  })

  test('a POST from an untrusted origin is refused, and one from a trusted origin is accepted', async () => {
    const body = { email: freshEmail(), password: PASSWORD }
    const evil = await call('POST', '/api/auth/sign-in/email', { ip: freshIp(), body, origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    const trusted = await call('POST', '/api/auth/sign-in/email', { ip: freshIp(), body, origin: TRUSTED })
    expect(trusted.status).toBe(401)
  })

  test('signing up with a registered email looks like a new sign-up and changes nothing', async () => {
    const email = freshEmail()
    const first = await call('POST', '/api/auth/sign-up/email', {
      ip: freshIp(),
      body: { email, password: PASSWORD, name: 'A' },
    })
    const again = await call('POST', '/api/auth/sign-up/email', {
      ip: freshIp(),
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
