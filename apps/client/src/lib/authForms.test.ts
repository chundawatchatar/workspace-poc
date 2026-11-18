import { beforeEach, describe, expect, test } from 'bun:test'
import { FormApi } from '@tanstack/react-form'
import { QueryClient } from '@tanstack/react-query'
import { waitFor } from '@testing-library/react'
import { delay, HttpResponse, http } from 'msw'
import { authError, authUser, rateLimited } from '../test/betterAuth'
import { server } from '../test/msw'
import {
  changePasswordSchema,
  emailSchema,
  forgotPasswordFormOptions,
  resetPasswordFormOptions,
  resetPasswordSchema,
  shownError,
  signInFormOptions,
  signInSchema,
  signUpCodeFormOptions,
  signUpCodeSchema,
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

    for (const code of ['', '12345', '1234567', '12 345', 'abcdef']) {
      expect(signUpCodeSchema.safeParse({ code }).success).toBe(false)
    }
    expect(problems(signUpCodeSchema.safeParse({ code: '12345' }))).toEqual({
      code: 'Enter the 6-digit code from the email.',
    })
    expect(signUpCodeSchema.parse({ code: ' 012345 ' }).code).toBe('012345')

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

  test('changing the password needs the current one, a valid new one and a matching confirmation', () => {
    expect(
      problems(changePasswordSchema.safeParse({ currentPassword: '', newPassword: 'short', confirmPassword: 'other' })),
    ).toEqual({
      currentPassword: 'Enter your current password.',
      newPassword: 'Use at least 8 characters.',
      confirmPassword: 'The passwords do not match.',
    })
    const value = { currentPassword: 'old', newPassword: 'x'.repeat(8), confirmPassword: 'x'.repeat(8) }
    expect(changePasswordSchema.safeParse(value).success).toBe(true)
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
  /** The form-level message as the page shows it, and what it was when the last request went out. */
  let problem: string | null = null
  let problemDuringRequest: string | null = null
  const setProblem = (message: string | null) => {
    problem = message
  }

  beforeEach(() => {
    problem = null
    problemDuringRequest = null
  })

  /** Answers sign-in with a refusal after a moment, so a second submit lands while it is in flight. */
  function refuseSignIn() {
    const requests: Request[] = []
    server.use(
      http.post('*/api/auth/sign-in/email', async ({ request }) => {
        requests.push(request)
        problemDuringRequest = problem
        await delay(20)
        return authError(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password')
      }),
    )
    return requests
  }

  /** Submits `form` unless a submit is in flight, and resolves once none is. */
  async function submitAndWait(form: Parameters<typeof submitOnce>[0]) {
    submitOnce(form)
    await waitFor(() => expect(form.state.isSubmitting).toBe(false))
  }

  test('a second sign-in submit sends nothing while one is in flight, and a refusal keeps the values', async () => {
    const requests = refuseSignIn()
    const form = new FormApi(signInFormOptions(new QueryClient(), { setProblem, onSignedIn: async () => {} }))
    form.mount()
    form.setFieldValue('email', 'a@example.com')
    form.setFieldValue('password', 'wrong password')

    submitOnce(form)
    expect(form.state.isSubmitting).toBe(true)
    // This second submit lands while the first is in flight.
    await submitAndWait(form)

    expect(requests).toHaveLength(1)
    expect(problem as string | null).toBe('Wrong email or password.')
    expect(form.state.values).toEqual({ email: 'a@example.com', password: 'wrong password' })

    // The old message is gone while the next request is on its way.
    await submitAndWait(form)
    expect(problemDuringRequest).toBeNull()
    expect(problem as string | null).toBe('Wrong email or password.')
  })

  test('Enter in a corrected field submits, though the field was empty when another field was left', async () => {
    const requests = refuseSignIn()
    const form = new FormApi(signInFormOptions(new QueryClient(), { setProblem, onSignedIn: async () => {} }))
    form.mount()
    form.setFieldValue('email', 'a@example.com')
    // Leaving the email field checks the whole form on blur, while the password is still empty.
    form.validate('blur')
    form.setFieldValue('password', 'typed but never left')
    await submitAndWait(form)
    expect(requests).toHaveLength(1)
  })

  test('the details screen sends only the address, keeps the values on a refusal, and hands the details on', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post('*/api/auth/email-otp/send-verification-otp', async ({ request }) => {
        problemDuringRequest = problem
        const body = (await request.json()) as { email: string }
        bodies.push(body)
        if (body.email === 'busy@example.com') return rateLimited()
        return HttpResponse.json({ success: true })
      }),
    )
    const handed: unknown[] = []
    const form = new FormApi(
      signUpFormOptions({ name: 'Ada', email: 'busy@example.com' }, { setProblem, onCodeSent: (d) => handed.push(d) }),
    )
    form.mount()
    expect(form.state.values).toEqual({ name: 'Ada', email: 'busy@example.com', password: '' })
    form.setFieldValue('password', 'long enough')
    await submitAndWait(form)
    expect(problem as string | null).toBe('Too many attempts. Wait a minute and try again.')
    expect(form.state.values.password).toBe('long enough')
    expect(handed).toEqual([])

    form.setFieldValue('email', ' ada@example.com ')
    await submitAndWait(form)
    expect(problemDuringRequest).toBeNull()
    expect(problem as string | null).toBeNull()
    expect(bodies).toEqual([
      { email: 'busy@example.com', type: 'sign-in' },
      { email: 'ada@example.com', type: 'sign-in' },
    ])
    expect(handed).toEqual([{ name: 'Ada', email: 'ada@example.com', password: 'long enough' }])
  })

  test('the code screen keeps the code on a refusal, and empties the form once the account exists', async () => {
    server.use(
      http.post('*/api/auth/sign-up/email-code', async ({ request }) => {
        const { code, email, name } = (await request.json()) as { code: string; email: string; name: string }
        if (code !== '123456') return authError(400, 'INVALID_OR_EXPIRED_CODE', 'Invalid or expired code')
        return HttpResponse.json({ token: 't1', user: authUser({ id: 'u1', email, name }) })
      }),
      http.get('*/api/auth/get-session', () => HttpResponse.json(null)),
    )
    let signedUp = 0
    const details = { name: 'Ada', email: 'ada@example.com', password: 'long enough' }
    const form = new FormApi(
      signUpCodeFormOptions(new QueryClient(), details, { setProblem, onSignedUp: async () => signedUp++ }),
    )
    form.mount()
    form.setFieldValue('code', '000000')
    await submitAndWait(form)
    expect(problem as string | null).toBe('That code is wrong or has expired. Check it, or send a new code.')
    expect(form.state.values.code).toBe('000000')
    expect(signedUp).toBe(0)

    form.setFieldValue('code', '123456')
    await submitAndWait(form)
    expect(problem as string | null).toBeNull()
    expect(form.state.values.code).toBe('')
    expect(signedUp).toBe(1)
  })

  test('a forgot-password submit empties the form and reports the address, or keeps it on a rate limit', async () => {
    server.use(
      http.post('*/api/auth/request-password-reset', async ({ request }) => {
        const { email } = (await request.json()) as { email: string }
        if (email === 'busy@example.com') return rateLimited()
        return HttpResponse.json({
          status: true,
          message: 'If this email exists in our system, check your email for the reset link',
        })
      }),
    )
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
    server.use(
      http.post('*/api/auth/reset-password', async ({ request }) => {
        const { token } = (await request.json()) as { token: string }
        if (token !== 'good') return authError(400, 'INVALID_TOKEN', 'Invalid token')
        return HttpResponse.json({ status: true })
      }),
      // A reset ends every session, so the page reads the session again and finds none.
      http.get('*/api/auth/get-session', () => HttpResponse.json(null)),
    )
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
