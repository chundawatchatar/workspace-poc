import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@orch/domain'
import { createTestDomain, type TestDomain } from '@orch/domain/testing'
import { count, eq, sql } from 'drizzle-orm'
import type { CaptureTransport } from '../mailer/mailer.testing'
import type { MailTransport } from '../mailer/mailer.transport'
import { DISABLED_EMAIL_OTP_PATHS } from './auth.service'
import { SIGN_UP_CODE_REFUSED } from './auth.sign-up-code'
import { accountsTestApp, cookiePair, sessionSetCookie, TEST_BASE, TEST_PASSWORD } from './auth.testing'

const FIRST_PASSWORD = 'first sign-up passphrase'
const SECOND_PASSWORD = 'second sign-up passphrase'

let domain: TestDomain
let mail: CaptureTransport
let client: ReturnType<typeof accountsTestApp>['client']
let failCredentialWrite = false
let captureSend: MailTransport['send']
const logLines: string[] = []
const originalConsole = { log: console.log, warn: console.warn, error: console.error }

beforeAll(async () => {
  // Kept instead of printed, so the last test can check that no code, address or password was logged.
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => void logLines.push(args.map(String).join(' '))
  }
  domain = await createTestDomain()
  const test = accountsTestApp(domain, '10.11.0', {
    beforeSignUpCredentialWrite: () => {
      if (failCredentialWrite) throw new Error('forced credential write failure')
    },
  })
  mail = test.mail
  client = test.client
  captureSend = mail.transport.send
})

afterEach(async () => {
  failCredentialWrite = false
  mail.transport.send = captureSend
  await db().execute(sql`DROP TRIGGER IF EXISTS fail_session_insert ON session`)
})

afterAll(async () => {
  Object.assign(console, originalConsole)
  await domain.close()
})

const db = () => domain.forAuthLibrary()

/** Asks for a code for a fresh address with no account and returns the address and the code it got. */
async function newAddressWithCode(): Promise<{ email: string; code: string }> {
  const email = client.freshEmail()
  expect((await client.sendCode(email, client.freshIp())).status).toBe(200)
  return { email, code: client.codeTo(email) }
}

/** A different 6-digit code than `code`. */
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000')

async function expectRefused(response: Response) {
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual(SIGN_UP_CODE_REFUSED)
  expect(sessionSetCookie(response)).toBeUndefined()
}

async function userRow(email: string) {
  return (await db().select().from(schema.user).where(eq(schema.user.email, email)))[0]
}

/** The user, its accounts and its sessions, to compare before and after a refused sign-up. */
async function accountState(email: string) {
  const user = await userRow(email)
  if (!user) throw new Error('no user for the address')
  const accounts = await db().select().from(schema.account).where(eq(schema.account.userId, user.id))
  const sessions = await db().select().from(schema.session).where(eq(schema.session.userId, user.id))
  return { user, accounts, sessionIds: sessions.map((s) => s.id).sort() }
}

async function signInStatus(email: string, password: string): Promise<number> {
  return (await client.call('POST', '/api/auth/sign-in/email', { ip: client.freshIp(), body: { email, password } }))
    .status
}

async function sessionUser(cookie: string) {
  const response = await client.call('GET', '/api/auth/get-session', { ip: client.freshIp(), cookie })
  const body = (await response.json()) as { user?: { email: string; name: string; emailVerified: boolean } } | null
  return body?.user ?? null
}

async function rowCounts() {
  const [users] = await db().select({ n: count() }).from(schema.user)
  const [accounts] = await db().select({ n: count() }).from(schema.account)
  const [sessions] = await db().select({ n: count() }).from(schema.session)
  return { users: users?.n, accounts: accounts?.n, sessions: sessions?.n }
}

describe('email-code sign-up', () => {
  test('asking for a code answers the same for every address, and only a new address gets a code', async () => {
    const fresh = client.freshEmail()
    const registered = client.freshEmail()
    await client.register(registered, client.freshIp())
    const before = mail.sent.filter((m) => m.to === registered).length

    const answers = []
    for (const email of [fresh, registered]) {
      const response = await client.sendCode(email, client.freshIp())
      answers.push({ status: response.status, body: await response.json() })
    }
    expect(answers[0]).toEqual({ status: 200, body: { success: true } })
    expect(answers[1]).toEqual(answers[0])

    expect(mail.sent.filter((m) => m.to === fresh)).toHaveLength(1)
    const code = client.codeTo(fresh)
    expect(code).toMatch(/^\d{6}$/)
    const rows = await db()
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.identifier, `sign-in-otp-${fresh}`))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).not.toContain(code)

    expect(mail.sent.filter((m) => m.to === registered).length).toBe(before + 1)
    const exists = client.accountExistsTo(registered)
    expect(exists).toHaveLength(1)
    const message = exists[0] as (typeof exists)[number]
    expect(message.text).toContain(`${TEST_BASE}/auth/sign-in`)
    expect(message.text).toContain(`${TEST_BASE}/auth/forgot-password`)
    expect(`${message.subject} ${message.text} ${message.html}`).not.toMatch(/\d{6}/)
    await expectRefused(
      await client.signUpWithCode(client.freshIp(), {
        name: 'X',
        email: registered,
        password: FIRST_PASSWORD,
        code: '123456',
      }),
    )
  })

  test('the right code with a name and password makes a verified, signed-in account, and works only once', async () => {
    const { email, code } = await newAddressWithCode()
    const short = await client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password: 'short', code })
    expect(short.status).toBe(400)
    expect(((await short.json()) as { code: string }).code).toBe('PASSWORD_TOO_SHORT')

    const response = await client.signUpWithCode(client.freshIp(), {
      name: 'Ada',
      email,
      password: FIRST_PASSWORD,
      code,
    })
    expect(response.status).toBe(200)
    const setCookie = sessionSetCookie(response) as string
    const attributes = setCookie.split(';').map((part) => part.trim().toLowerCase())
    expect(attributes).toEqual(expect.arrayContaining(['path=/api', 'httponly', 'secure', 'samesite=lax']))
    expect(await sessionUser(cookiePair(setCookie))).toMatchObject({ email, name: 'Ada', emailVerified: true })

    const { accounts } = await accountState(email)
    expect(accounts.map((a) => a.providerId)).toEqual(['credential'])
    expect(await signInStatus(email, FIRST_PASSWORD)).toBe(200)

    await expectRefused(
      await client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password: SECOND_PASSWORD, code }),
    )
  })

  test('three wrong codes lock the code, each refused like the right one is afterwards', async () => {
    const { email, code } = await newAddressWithCode()
    for (let i = 0; i < 3; i++) {
      await expectRefused(
        await client.signUpWithCode(client.freshIp(), {
          name: 'Ada',
          email,
          password: FIRST_PASSWORD,
          code: wrongCode(code),
        }),
      )
    }
    await expectRefused(
      await client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password: FIRST_PASSWORD, code }),
    )
    expect(await userRow(email)).toBeUndefined()
  })

  test('a code still valid once another email-code sign-up made the account neither signs in nor changes it', async () => {
    const { email, code } = await newAddressWithCode()
    const codeRows = await db()
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.identifier, `sign-in-otp-${email}`))
    expect((await client.sendCode(email, client.freshIp())).status).toBe(200)
    const winner = await client.signUpWithCode(client.freshIp(), {
      name: 'Owner',
      email,
      password: FIRST_PASSWORD,
      code: client.codeTo(email),
    })
    expect(winner.status).toBe(200)
    const ownerCookie = cookiePair(sessionSetCookie(winner) as string)
    // A new send replaces the first code, so put it back to stand for a valid code that meets an existing account.
    await db().insert(schema.verification).values(codeRows)
    const before = await accountState(email)

    await expectRefused(
      await client.signUpWithCode(client.freshIp(), { name: 'Intruder', email, password: SECOND_PASSWORD, code }),
    )
    expect(await accountState(email)).toEqual(before)
    expect(await sessionUser(ownerCookie)).toMatchObject({ email, name: 'Owner' })
    expect(await signInStatus(email, FIRST_PASSWORD)).toBe(200)
    expect(await signInStatus(email, SECOND_PASSWORD)).toBe(401)
  })

  test('concurrent submissions of one code make one account, and only the winner holds it', async () => {
    const same = await newAddressWithCode()
    const body = { name: 'Ada', email: same.email, password: FIRST_PASSWORD, code: same.code }
    const twins = await Promise.all([
      client.signUpWithCode(client.freshIp(), body),
      client.signUpWithCode(client.freshIp(), body),
    ])
    expect(twins.map((r) => r.status).sort()).toEqual([200, 400])
    await expectRefused(twins.find((r) => r.status === 400) as Response)
    expect(await db().select().from(schema.user).where(eq(schema.user.email, same.email))).toHaveLength(1)

    const { email, code } = await newAddressWithCode()
    const passwords = [FIRST_PASSWORD, SECOND_PASSWORD]
    const rivals = await Promise.all(
      passwords.map((password) => client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password, code })),
    )
    expect(rivals.map((r) => r.status).sort()).toEqual([200, 400])
    expect(await db().select().from(schema.user).where(eq(schema.user.email, email))).toHaveLength(1)
    const won = rivals.findIndex((r) => r.status === 200)
    expect(await signInStatus(email, passwords[won] as string)).toBe(200)
    expect(await signInStatus(email, passwords[1 - won] as string)).toBe(401)
  })

  test('a failed password write leaves no user, account or session, and spends the code', async () => {
    const { email, code } = await newAddressWithCode()
    const before = await rowCounts()
    failCredentialWrite = true
    const failed = await client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password: FIRST_PASSWORD, code })
    failCredentialWrite = false
    await expectRefused(failed)
    expect(await rowCounts()).toEqual(before)
    expect(await userRow(email)).toBeUndefined()

    await expectRefused(
      await client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password: FIRST_PASSWORD, code }),
    )
    expect((await client.sendCode(email, client.freshIp())).status).toBe(200)
    const retry = await client.signUpWithCode(client.freshIp(), {
      name: 'Ada',
      email,
      password: FIRST_PASSWORD,
      code: client.codeTo(email),
    })
    expect(retry.status).toBe(200)
  })

  test('a step that fails after creating the user leaves no user, account or session behind', async () => {
    const { email, code } = await newAddressWithCode()
    // A real database fault after the step's user insert: starting the session fails.
    await db().execute(sql`
      CREATE OR REPLACE FUNCTION fail_session_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced session failure'; END $$ LANGUAGE plpgsql`)
    await db().execute(sql`
      CREATE TRIGGER fail_session_insert BEFORE INSERT ON session
      FOR EACH ROW EXECUTE FUNCTION fail_session_insert()`)
    const before = await rowCounts()

    await expectRefused(
      await client.signUpWithCode(client.freshIp(), { name: 'Ada', email, password: FIRST_PASSWORD, code }),
    )
    expect(await rowCounts()).toEqual(before)
    expect(await userRow(email)).toBeUndefined()
  })

  test('asking for a code never waits for the email, and a failed send still gets the same answer', async () => {
    const registered = client.freshEmail()
    await client.register(registered, client.freshIp())
    // A send that never finishes: the answer must not wait for it.
    mail.transport.send = () => new Promise<void>(() => {})
    for (const email of [client.freshEmail(), registered]) {
      const response = await client.sendCode(email, client.freshIp())
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { success: true } })
    }

    mail.transport.send = async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNECTION' })
    }
    for (const email of [client.freshEmail(), registered]) {
      const response = await client.sendCode(email, client.freshIp())
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { success: true } })
    }
    await Bun.sleep(0)
    expect(logLines).toEqual(
      expect.arrayContaining(['mail signUpCode: failed (ECONNECTION)', 'mail accountExists: failed (ECONNECTION)']),
    )
  })

  test('the emailOTP paths the client never calls are closed over HTTP', async () => {
    const body = { email: client.freshEmail(), otp: '123456', type: 'sign-in' }
    for (const path of DISABLED_EMAIL_OTP_PATHS) {
      const response = await client.call('POST', `/api/auth${path}`, { ip: client.freshIp(), body })
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
    }
    expect((await client.sendCode(client.freshEmail(), client.freshIp())).status).not.toBe(404)
    const signUp = await client.signUpWithCode(client.freshIp(), {
      name: 'A',
      email: body.email,
      password: '',
      code: '',
    })
    expect(signUp.status).not.toBe(404)
  })

  // Runs last, after every flow above has logged what it logs.
  test('no log line holds a code, an email address or a password', () => {
    const codes = mail.sent.flatMap((m) => m.text.match(/\b\d{6}\b/g) ?? [])
    expect(codes.length).toBeGreaterThan(0)
    expect(logLines.length).toBeGreaterThan(0)
    for (const line of logLines) {
      expect(line).not.toContain('@test.example')
      for (const secret of [...codes, FIRST_PASSWORD, SECOND_PASSWORD, TEST_PASSWORD]) {
        expect(line).not.toContain(secret)
      }
    }
  })
})
