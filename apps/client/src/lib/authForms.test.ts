import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FormApi } from '@tanstack/react-form'
import { QueryClient } from '@tanstack/react-query'
import {
  emailSchema,
  forgotPasswordFormOptions,
  resetPasswordFormOptions,
  resetPasswordSchema,
  shownError,
  signInFormOptions,
  signInSchema,
  signUpFormOptions,
  signUpSchema,
  submitOnce,
} from './authForms'

/** The message for each field that fails, keyed by field name. */
function problems(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries((result.error?.issues ?? []).map((issue) => [String(issue.path[0]), issue.message]))
}

describe('the auth schemas', () => {
  test('each missing or malformed field gets its own readable message', () => {
    expect(problems(signInSchema.safeParse({ email: '', password: '' }))).toEqual({
      email: 'Enter your email address.',
      password: 'Enter your password.',
    })
    expect(problems(signInSchema.safeParse({ email: 'not-an-email', password: 'x' }))).toEqual({
      email: 'Enter a valid email address.',
    })
    expect(signInSchema.parse({ email: ' a@example.com ', password: 'x' }).email).toBe('a@example.com')

    expect(problems(signUpSchema.safeParse({ name: ' ', email: 'a@example.com', password: 'short' }))).toEqual({
      name: 'Enter your name.',
      password: 'Use at least 8 characters.',
    })
    expect(problems(signUpSchema.safeParse({ name: 'Ada', email: 'a@example', password: 'x'.repeat(129) }))).toEqual({
      email: 'Enter a valid email address.',
      password: 'Use at most 128 characters.',
    })
    expect(signUpSchema.safeParse({ name: 'Ada', email: 'a@example.com', password: 'x'.repeat(128) }).success).toBe(
      true,
    )

    expect(problems(emailSchema.safeParse({ email: ' ' }))).toEqual({ email: 'Enter your email address.' })
    expect(emailSchema.parse({ email: ' a@example.com ' }).email).toBe('a@example.com')
    expect(problems(resetPasswordSchema.safeParse({ password: 'x'.repeat(7) }))).toEqual({
      password: 'Use at least 8 characters.',
    })
    expect(problems(resetPasswordSchema.safeParse({ password: 'x'.repeat(129) }))).toEqual({
      password: 'Use at most 128 characters.',
    })
    expect(resetPasswordSchema.safeParse({ password: 'x'.repeat(8) }).success).toBe(true)
  })
})

describe('shownError', () => {
  test('a field says nothing until it was left or the form submitted', () => {
    const errors = [{ message: 'Enter your password.' }]
    expect(shownError({ isBlurred: false, errors }, 0)).toBeNull()
    expect(shownError({ isBlurred: true, errors }, 0)).toBe('Enter your password.')
    expect(shownError({ isBlurred: false, errors }, 1)).toBe('Enter your password.')
    expect(shownError({ isBlurred: true, errors: [undefined] }, 1)).toBeNull()
  })
})

describe('the sign-in and sign-up forms', () => {
  const realFetch = globalThis.fetch
  const realLocation = globalThis.location
  let signInRequests = 0
  /** The form-level message as the page shows it, and what it was when the last request went out. */
  let problem: string | null = null
  let problemDuringRequest: string | null = null
  const setProblem = (message: string | null) => {
    problem = message
  }

  beforeAll(() => {
    globalThis.location = { origin: 'http://localhost:3220' } as Location
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
      problemDuringRequest = problem
      await Bun.sleep(20)
      if (path === '/api/auth/sign-in/email') {
        signInRequests++
        return Response.json({ message: 'Invalid email or password' }, { status: 401 })
      }
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.email === 'busy@example.com') return Response.json({ message: 'Too many requests' }, { status: 429 })
      if (path === '/api/auth/sign-up/email') {
        return Response.json({ token: null, user: { id: 'new', email: body.email, name: 'Ada' } })
      }
      if (path === '/api/auth/reset-password' && body.token !== 'good') {
        return Response.json({ code: 'INVALID_TOKEN' }, { status: 400 })
      }
      return Response.json({ status: true })
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.location = realLocation
    globalThis.fetch = realFetch
  })

  /** Submits `form` unless a submit is in flight, and resolves once none is. */
  async function submitAndWait(form: Parameters<typeof submitOnce>[0]) {
    submitOnce(form)
    for (let i = 0; i < 100 && form.state.isSubmitting; i++) await Bun.sleep(10)
  }

  test('a second sign-in submit sends nothing while one is in flight, and a refusal keeps the values', async () => {
    const form = new FormApi(signInFormOptions(new QueryClient(), { setProblem, onSignedIn: async () => {} }))
    form.mount()
    form.setFieldValue('email', 'a@example.com')
    form.setFieldValue('password', 'wrong password')

    submitOnce(form)
    expect(form.state.isSubmitting).toBe(true)
    // This second submit lands while the first is in flight.
    await submitAndWait(form)

    expect(signInRequests).toBe(1)
    expect(problem as string | null).toBe('Wrong email or password.')
    expect(form.state.values).toEqual({ email: 'a@example.com', password: 'wrong password' })

    // The old message is gone while the next request is on its way.
    await submitAndWait(form)
    expect(problemDuringRequest).toBeNull()
    expect(problem as string | null).toBe('Wrong email or password.')
  })

  test('Enter in a corrected field submits, though the field was empty when another field was left', async () => {
    const form = new FormApi(signInFormOptions(new QueryClient(), { setProblem, onSignedIn: async () => {} }))
    form.mount()
    const requests = signInRequests
    form.setFieldValue('email', 'a@example.com')
    // Leaving the email field checks the whole form on blur, while the password is still empty.
    form.validate('blur')
    form.setFieldValue('password', 'typed but never left')
    await submitAndWait(form)
    expect(signInRequests).toBe(requests + 1)
  })

  test('sign-up clears the last refusal as it submits, and empties the form once the email is sent', async () => {
    problem = null
    let sentTo: string | null = null
    const form = new FormApi(signUpFormOptions({ setProblem, onSent: (email) => (sentTo = email) }))
    form.mount()
    form.setFieldValue('name', 'Ada')
    form.setFieldValue('email', 'busy@example.com')
    form.setFieldValue('password', 'long enough')
    await submitAndWait(form)
    expect(problem as string | null).toBe('Too many attempts. Wait a minute and try again.')
    expect(form.state.values.password).toBe('long enough')

    form.setFieldValue('email', 'ada@example.com')
    await submitAndWait(form)
    expect(problemDuringRequest).toBeNull()
    expect(problem as string | null).toBeNull()
    expect(sentTo as string | null).toBe('ada@example.com')
    expect(form.state.values).toEqual({ name: '', email: '', password: '' })
  })

  test('a forgot-password submit empties the form and reports the address, or keeps it on a rate limit', async () => {
    problem = null
    const sent: string[] = []
    const form = new FormApi(forgotPasswordFormOptions({ setProblem, onSent: (email) => sent.push(email) }))
    form.mount()
    form.setFieldValue('email', 'busy@example.com')
    await submitAndWait(form)
    expect(problem as string | null).toBe('Too many attempts. Wait a minute and try again.')
    expect(form.state.values.email).toBe('busy@example.com')

    form.setFieldValue('email', ' ada@example.com ')
    await submitAndWait(form)
    expect(problem as string | null).toBeNull()
    expect(sent).toEqual(['ada@example.com'])
    expect(form.state.values.email).toBe('')
  })

  test('a reset submit with a refused token says the link expired, and a valid one empties the form', async () => {
    const outcomes: string[] = []
    const callbacks = {
      setProblem,
      onExpired: () => outcomes.push('expired'),
      onChanged: () => outcomes.push('changed'),
    }
    for (const token of ['used', 'good']) {
      const form = new FormApi(resetPasswordFormOptions(new QueryClient(), token, callbacks))
      form.mount()
      form.setFieldValue('password', 'a brand new passphrase')
      await submitAndWait(form)
      expect(form.state.values.password).toBe(token === 'good' ? '' : 'a brand new passphrase')
    }
    expect(outcomes).toEqual(['expired', 'changed'])
  })
})
