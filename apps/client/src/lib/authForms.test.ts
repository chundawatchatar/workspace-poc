import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FormApi } from '@tanstack/react-form'
import { QueryClient } from '@tanstack/react-query'
import { signInWithEmail } from './auth'
import { shownError, signInSchema, signUpSchema, submitOnce } from './authForms'

/** The message for each field that fails, keyed by field name. */
function problems(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries((result.error?.issues ?? []).map((issue) => [String(issue.path[0]), issue.message]))
}

describe('signInSchema and signUpSchema', () => {
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

describe('the sign-in form', () => {
  const realFetch = globalThis.fetch
  const realLocation = globalThis.location
  let signInRequests = 0

  beforeAll(() => {
    globalThis.location = { origin: 'http://localhost:3220' } as Location
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
      if (path !== '/api/auth/sign-in/email') return Response.json(null)
      signInRequests++
      await Bun.sleep(20)
      return Response.json({ message: 'Invalid email or password' }, { status: 401 })
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.location = realLocation
    globalThis.fetch = realFetch
  })

  test('a second submit while one is in flight sends nothing, and a refusal keeps the values', async () => {
    const queryClient = new QueryClient()
    let problem: string | null = null
    // Set up like the `/sign-in` page's form.
    const form = new FormApi({
      defaultValues: { email: '', password: '' },
      validators: { onChange: signInSchema, onBlur: signInSchema },
      onSubmit: async ({ value }) => {
        const { email, password } = signInSchema.parse(value)
        problem = await signInWithEmail(queryClient, email, password)
      },
    })
    form.mount()
    form.setFieldValue('email', 'a@example.com')
    form.setFieldValue('password', 'wrong password')

    submitOnce(form)
    expect(form.state.isSubmitting).toBe(true)
    submitOnce(form)
    for (let i = 0; i < 100 && form.state.isSubmitting; i++) await Bun.sleep(10)

    expect(signInRequests).toBe(1)
    expect(problem as string | null).toBe('Wrong email or password.')
    expect(form.state.values).toEqual({ email: 'a@example.com', password: 'wrong password' })
  })
})
