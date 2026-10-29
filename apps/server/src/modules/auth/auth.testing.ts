import type { Hono } from 'hono'
import type { CaptureTransport } from '../mailer/mailer.testing'

// Test-only helpers for driving Better Auth through `createApp`. Never imported by production code.

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

  /** Sends a request as Bun would, from socket address `ip`, with a JSON body on a POST. */
  function call(method: 'GET' | 'POST', path: string, { ip, body, cookie, origin, headers = {} }: CallOptions) {
    const server = { upgrade: () => false, requestIP: () => ({ address: ip, family: 'IPv4', port: 40000 }) }
    // Bun fills `Host` from the request line; `app.request` doesn't, and the server API's origin check needs it.
    const h: Record<string, string> = { host: new URL(base).host, ...headers }
    const init: RequestInit = { method, headers: h }
    if (cookie) h.cookie = cookie
    if (method === 'POST') {
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

  /** Signs up, follows the verification link and signs in, returning the session cookie line. */
  async function verifiedUser(email: string, ip: string, name = 'Test'): Promise<string> {
    await call('POST', '/api/auth/sign-up/email', { ip, body: { email, password: TEST_PASSWORD, name } })
    const link = linkTo(email, 'verifyEmail')
    await call('GET', `${link.pathname}${link.search}`, { ip })
    const signIn = await call('POST', '/api/auth/sign-in/email', { ip, body: { email, password: TEST_PASSWORD } })
    const setCookie = sessionSetCookie(signIn)
    if (signIn.status !== 200 || !setCookie) throw new Error(`sign-in answered ${signIn.status}`)
    return setCookie
  }

  return {
    call,
    linkTo,
    verifiedUser,
    freshIp: () => `${ipPrefix}.${nextIp++}`,
    freshEmail: () => `${ipPrefix.replaceAll('.', '-')}-user${nextEmail++}@test.example`,
  }
}
