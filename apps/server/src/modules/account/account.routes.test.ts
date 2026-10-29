import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import { defineServerContract } from '@orch/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { type ApiModule, createApp } from '../../app'
import { clientIpReader } from '../../lib/clientIp'
import { createServerRouter, type ServerHandlerContext, type ServerRouterOptions } from '../../lib/createServerRouter'
import { createAuthenticate } from '../auth/auth.middleware'
import { createAuthModule } from '../auth/auth.routes'
import { createAuth } from '../auth/auth.service'
import { authTestClient, cookiePair } from '../auth/auth.testing'
import { ChannelBridge } from '../bridge/bridge.service'
import { HttpForwarder } from '../forward/forward.service'
import { ConnectionLimiter } from '../limits/limits.service'
import { createMailer } from '../mailer/mailer.service'
import { createCaptureTransport } from '../mailer/mailer.testing'
import { MachineRegistry } from '../tunnel/tunnel.service'
import { createAccountModule } from './account.routes'

const BASE = 'http://orch.example'
const TRUSTED = 'https://app.example'
const SECRET = 'a-test-secret-that-is-at-least-32-bytes-long'

// Test-only endpoints served with the real `authenticate` and `forUser`, to see what a handler gets and whether it ran.
const probeContract = defineServerContract({
  peek: {
    method: 'GET',
    path: '/api/test-probe',
    description: 'test',
    input: z.object({}),
    output: z.object({ userId: z.string() }),
  },
  write: {
    method: 'POST',
    path: '/api/test-probe',
    description: 'test',
    input: z.object({ note: z.string() }),
    output: z.object({ userId: z.string(), hasData: z.boolean() }),
  },
})

type Probe = typeof probeContract

function probeModule() {
  const peek = mock(async (_input: unknown, { principal }: ServerHandlerContext<Probe['peek']>) => ({
    userId: principal.userId,
  }))
  const write = mock(async (_input: { note: string }, { principal, data }: ServerHandlerContext<Probe['write']>) => ({
    userId: principal.userId,
    hasData: data !== null && typeof data === 'object',
  }))
  const module: ApiModule = (options) => createServerRouter(probeContract, { peek, write }, options)
  return { module, peek, write }
}

/** An app with accounts on over `domain`, as `index.ts` builds it, and the errors its routers report. */
function setup(domain: TestDomain, ipPrefix: string) {
  const mail = createCaptureTransport()
  const auth = createAuth({
    domain,
    mailer: createMailer({ transport: mail.transport, from: 'Orch <no-reply@orch.example>' }),
    secret: SECRET,
    baseUrl: BASE,
    trustedOrigins: [TRUSTED],
  })
  const errors: unknown[] = []
  const api: ServerRouterOptions = {
    trustedOrigins: [TRUSTED],
    authenticate: createAuthenticate({ auth }),
    forUser: (principal) => domain.forUser(principal),
    onError: (_endpoint, error) => void errors.push(error),
  }
  const probe = probeModule()
  const registry = new MachineRegistry()
  const app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(),
    api,
    accounts: {
      modules: [
        createAuthModule({ auth, clientIp: clientIpReader({ trustProxy: false }) }),
        createAccountModule(),
        probe.module,
      ],
    },
  })
  return { app, probe, errors, client: authTestClient({ app, mail, base: BASE, ipPrefix }) }
}

/** A cookie value as Better Auth signs it: `token.signature`, HMAC-SHA256 in base64, URL-encoded. */
function signCookieValue(token: string, secret: string): string {
  return encodeURIComponent(`${token}.${createHmac('sha256', secret).update(token).digest('base64')}`)
}

async function errorOf(response: Response) {
  return { status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }
}

let domain: TestDomain
let ctx: ReturnType<typeof setup>

beforeAll(async () => {
  domain = await createTestDomain({ log: () => {} })
  ctx = setup(domain, '10.1.0')
})

afterAll(async () => {
  await domain.close()
})

/** Signs a fresh user in and returns their email, the cookie pair a browser sends, and the IP to send it from. */
async function signedIn() {
  const email = ctx.client.freshEmail()
  const ip = ctx.client.freshIp()
  const cookie = cookiePair(await ctx.client.verifiedUser(email, ip, 'Ada Lovelace'))
  return { email, ip, cookie }
}

/** Checks that `/api/me` and the probe both refuse `cookie` with 401 and that no handler ran. */
async function expectRefused(ip: string, cookie?: string) {
  const callsBefore = ctx.probe.peek.mock.calls.length
  for (const path of ['/api/me', '/api/test-probe']) {
    expect(await errorOf(await ctx.client.call('GET', path, { ip, cookie }))).toEqual({
      status: 401,
      code: 'unauthorized',
    })
  }
  expect(ctx.probe.peek.mock.calls.length).toBe(callsBefore)
}

describe('account module', () => {
  test('`GET /api/me` answers exactly the signed-in user, uncached', async () => {
    const { email, ip, cookie } = await signedIn()
    const response = await ctx.client.call('GET', '/api/me', { ip, cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const [user] = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
    expect(await response.json()).toEqual({ id: user?.id as string, email, name: 'Ada Lovelace' })
  })

  test('refuses no cookie, an expired session and a session ended by sign-out', async () => {
    await expectRefused(ctx.client.freshIp())

    const expired = await signedIn()
    const token = decodeURIComponent(expired.cookie.split('=')[1] as string).split('.')[0] as string
    await domain
      .skipAuthorization('test: expire a session')
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.session.token, token))
    await expectRefused(expired.ip, expired.cookie)

    const out = await signedIn()
    expect((await ctx.client.call('GET', '/api/me', out)).status).toBe(200)
    expect((await ctx.client.call('POST', '/api/auth/sign-out', out)).status).toBe(200)
    await expectRefused(out.ip, out.cookie)
  })

  test('refuses a tampered cookie and one signed with another secret', async () => {
    const { ip, cookie } = await signedIn()
    const [name, value] = cookie.split('=') as [string, string]
    const token = decodeURIComponent(value).split('.')[0] as string
    // Proves the forgery below is well-formed: signing with the real secret reproduces the real cookie.
    expect(signCookieValue(token, SECRET)).toBe(value)

    const changed = `${value[0] === 'a' ? 'b' : 'a'}${value.slice(1)}`
    await expectRefused(ip, `${name}=${changed}`)
    await expectRefused(ip, `${name}=${signCookieValue(token, 'another-secret-that-is-at-least-32-bytes')}`)
    expect((await ctx.client.call('GET', '/api/me', { ip, cookie })).status).toBe(200)
  })

  test('a user mutation checks the origin and the content type before the session, then gets scoped data', async () => {
    const { email, ip, cookie } = await signedIn()
    const body = { note: 'hi' }
    const evil = await ctx.client.call('POST', '/api/test-probe', { ip, cookie, body, origin: 'https://evil.example' })
    expect(await errorOf(evil)).toEqual({ status: 403, code: 'forbidden_origin' })
    const plain = await ctx.client.call('POST', '/api/test-probe', {
      ip,
      cookie,
      body,
      headers: { 'content-type': 'text/plain' },
    })
    expect(await errorOf(plain)).toEqual({ status: 415, code: 'unsupported_media_type' })
    expect(ctx.probe.write).not.toHaveBeenCalled()

    const ok = await ctx.client.call('POST', '/api/test-probe', { ip, cookie, body })
    expect(ok.status).toBe(200)
    const [user] = await domain.forAuthLibrary().select().from(schema.user).where(eq(schema.user.email, email))
    expect(await ok.json()).toEqual({ userId: user?.id as string, hasData: true })
    expect(ctx.probe.write).toHaveBeenCalledTimes(1)
  })

  test('fails closed with 500 when the session cannot be read, and reports no cookie or email', async () => {
    const broken = await createTestDomain({ log: () => {} })
    const own = setup(broken, '10.2.0')
    const email = own.client.freshEmail()
    const ip = own.client.freshIp()
    const cookie = cookiePair(await own.client.verifiedUser(email, ip))
    await broken.close()

    const logLines: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => void logLines.push(args.map((arg) => Bun.inspect(arg)).join(' '))
    try {
      expect(await errorOf(await own.client.call('GET', '/api/me', { ip, cookie }))).toEqual({
        status: 500,
        code: 'internal',
      })
    } finally {
      console.error = originalError
    }
    expect(own.errors).toHaveLength(1)
    const token = decodeURIComponent(cookie.split('=')[1] as string).split('.')[0] as string
    for (const text of [Bun.inspect(own.errors[0]), ...logLines]) {
      for (const secret of [token, cookie, email]) expect(text).not.toContain(secret)
    }
  })

  test('answers the JSON `not_found` for `/api/me` when accounts are off', async () => {
    const registry = new MachineRegistry()
    const app = createApp({
      registry,
      forwarder: new HttpForwarder({ registry }),
      bridge: new ChannelBridge({ registry }),
      limiter: new ConnectionLimiter(),
    })
    expect(await errorOf(await app.request(`${BASE}/api/me`))).toEqual({ status: 404, code: 'not_found' })
  })
})
