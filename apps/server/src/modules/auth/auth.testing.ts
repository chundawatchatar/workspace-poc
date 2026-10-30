import type { TestDomain } from '@orch/domain/testing'
import type { Hono } from 'hono'
import { createApp } from '../../app'
import { clientIpReader } from '../../lib/clientIp'
import { createAccountModule } from '../account/account.routes'
import { ChannelBridge } from '../bridge/bridge.service'
import { HttpForwarder } from '../forward/forward.service'
import { ConnectionLimiter } from '../limits/limits.service'
import { createMachinesModule } from '../machines/machines.routes'
import { createMailer } from '../mailer/mailer.service'
import { type CaptureTransport, createCaptureTransport } from '../mailer/mailer.testing'
import { MachineRegistry } from '../tunnel/tunnel.service'
import { createAuthenticate } from './auth.middleware'
import { createAuthModule } from './auth.routes'
import { createAuth } from './auth.service'

// Test-only helpers for driving Better Auth through `createApp`. Never imported by production code.

/** The base URL test apps run on. */
export const TEST_BASE = 'http://orch.example'

/** The one origin besides `TEST_BASE` that test apps trust. */
export const TEST_TRUSTED_ORIGIN = 'https://app.example'

/** The test password every `verifiedUser` signs up with. */
export const TEST_PASSWORD = 'correct horse battery'

/** The session cookie's name on an `http://` base URL, where it has no `__Secure-` prefix. */
export const SESSION_COOKIE = 'better-auth.session_token'

/** What a test request carries. */
export interface CallOptions {
  /** The socket address the request comes from. */
  ip: string
  body?: unknown
  cookie?: string
  /** Defaults to the server's own origin on a non-GET request. */
  origin?: string
  headers?: Record<string, string>
}

/** The session cookie a response sets, with its attributes, or undefined when it sets none. */
export function sessionSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`))
}

/** The token in an email link's `#token=` fragment, as the client page reads it. */
export function linkToken(link: URL): string {
  const token = new URLSearchParams(link.hash.slice(1)).get('token')
  if (!token) throw new Error('the link has no token in its fragment')
  return token
}

/** The `name=value` pair a browser would send back for a `Set-Cookie` line. */
export const cookiePair = (setCookie: string) => setCookie.split(';')[0] as string

/**
 * Helpers bound to one app on `base` and the capture transport its mailer
 * sends through. Better Auth keeps its rate-limit counters in memory per
 * process, so each test file passes its own `ipPrefix` and each scenario
 * takes a `freshIp()`.
 */
export function authTestClient({
  app,
  mail,
  base,
  ipPrefix,
}: {
  app: Hono
  mail: CaptureTransport
  base: string
  ipPrefix: string
}) {
  let nextIp = 1
  let nextEmail = 1

  /** Sends a request as Bun would, from socket address `ip`, with a JSON body on anything but a GET. */
  function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    { ip, body, cookie, origin, headers = {} }: CallOptions,
  ) {
    const server = { upgrade: () => false, requestIP: () => ({ address: ip, family: 'IPv4', port: 40000 }) }
    // Bun fills `Host` from the request line; `app.request` doesn't, and the server API's origin check needs it.
    const h: Record<string, string> = { host: new URL(base).host, ...headers }
    const init: RequestInit = { method, headers: h }
    if (cookie) h.cookie = cookie
    if (method !== 'GET') {
      h.origin = origin ?? base
      h['content-type'] ??= 'application/json'
      init.body = JSON.stringify(body ?? {})
    }
    return app.request(`${base}${path}`, init, server)
  }

  /** The link in the last email of `template` sent to `address`. */
  function linkTo(address: string, template: 'verifyEmail' | 'resetPassword'): URL {
    const subject = template === 'verifyEmail' ? 'Verify your email address' : 'Reset your password'
    const message = mail.sent.filter((m) => m.to === address && m.subject === subject).at(-1)
    const url = message?.text.match(/https?:\/\/\S+/)?.[0]
    if (!url) throw new Error(`no ${template} link for the address`)
    return new URL(url)
  }

  /** Signs up and verifies with the link's token as the client page does, leaving a verified user with no session. */
  async function register(email: string, ip: string, name = 'Test'): Promise<void> {
    await call('POST', '/api/auth/sign-up/email', { ip, body: { email, password: TEST_PASSWORD, name } })
    const token = linkToken(linkTo(email, 'verifyEmail'))
    const verify = await call('GET', `/api/auth/verify-email?token=${encodeURIComponent(token)}`, { ip })
    if (verify.status !== 200) throw new Error(`verify-email answered ${verify.status}`)
  }

  /** Signs up, follows the verification link and signs in, returning the session cookie line. */
  async function verifiedUser(email: string, ip: string, name = 'Test'): Promise<string> {
    await register(email, ip, name)
    const setCookie = sessionSetCookie(await signInResponse(email, ip))
    if (!setCookie) throw new Error('sign-in set no session cookie')
    return setCookie
  }

  /**
   * Signs a verified user in with `TEST_PASSWORD` from `ip`, starting one more
   * session, and returns the `Cookie` header a browser would send back: every
   * cookie the sign-in set, so a session cache cookie would count too.
   */
  async function signIn(email: string, ip: string): Promise<string> {
    return (await signInResponse(email, ip)).headers.getSetCookie().map(cookiePair).join('; ')
  }

  async function signInResponse(email: string, ip: string): Promise<Response> {
    const response = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: TEST_PASSWORD } })
    if (response.status !== 200) throw new Error(`sign-in answered ${response.status}`)
    return response
  }

  return {
    call,
    linkTo,
    register,
    verifiedUser,
    signIn,
    freshIp: () => `${ipPrefix}.${nextIp++}`,
    freshEmail: () => `${ipPrefix.replaceAll('.', '-')}-user${nextEmail++}@test.example`,
  }
}

/**
 * An app with accounts on over `domain`, as `index.ts` builds it: Better Auth,
 * the account and machines endpoints, with the real `authenticate` and
 * `forUser`, and the `registry` the machines module reads online state from.
 */
export function accountsTestApp(domain: TestDomain, ipPrefix: string) {
  const mail = createCaptureTransport()
  const auth = createAuth({
    domain,
    mailer: createMailer({ transport: mail.transport, from: 'Orch <no-reply@orch.example>' }),
    secret: 'a-test-secret-that-is-at-least-32-bytes-long',
    baseUrl: TEST_BASE,
    trustedOrigins: [TEST_TRUSTED_ORIGIN],
  })
  const registry = new MachineRegistry()
  const app = createApp({
    registry,
    forwarder: new HttpForwarder({ registry }),
    bridge: new ChannelBridge({ registry }),
    limiter: new ConnectionLimiter(),
    api: {
      trustedOrigins: [TEST_TRUSTED_ORIGIN],
      authenticate: createAuthenticate({ auth }),
      forUser: (principal) => domain.forUser(principal),
    },
    accounts: {
      modules: [
        createAuthModule({ auth, clientIp: clientIpReader({ trustProxy: false }) }),
        createAccountModule(),
        createMachinesModule({ registry }),
      ],
    },
  })
  return { app, mail, registry, client: authTestClient({ app, mail, base: TEST_BASE, ipPrefix }) }
}
