import { describe, expect, spyOn, test } from 'bun:test'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { SIGN_UP_CODE_REFUSED, TOO_MANY_ATTEMPTS } from './lib/auth'
import { account, fakeSession, installAppFakes, quietMachine, show, user } from './test/appRouter'
import { authError, authUser, rateLimited } from './test/betterAuth'
import { server } from './test/msw'

// The sign-up page's two screens, loaded through the app's router: the details, then the emailed code.

installAppFakes()

/** Answers the email-code sign-up as the cloud server does, recording each request's body. */
function signUpServer() {
  const sends: unknown[] = []
  const signUps: unknown[] = []
  let sendAnswer: () => Response = () => HttpResponse.json({ success: true })
  let signUpAnswer: () => Response = () => {
    fakeSession.signedIn = true
    return HttpResponse.json({ token: 't1', user: authUser(user) })
  }
  server.use(
    http.post('*/api/auth/email-otp/send-verification-otp', async ({ request }) => {
      sends.push(await request.json())
      return sendAnswer()
    }),
    http.post('*/api/auth/sign-up/email-code', async ({ request }) => {
      signUps.push(await request.json())
      return signUpAnswer()
    }),
  )
  return {
    sends,
    signUps,
    answerSend: (answer: () => Response) => (sendAnswer = answer),
    answerSignUp: (answer: () => Response) => (signUpAnswer = answer),
  }
}

const password = 'a long sign-up passphrase'

/** Opens `path` signed out, fills in the details screen and sends the code, landing on the code screen. */
async function reachCodeScreen(path: string, fake = signUpServer()) {
  fakeSession.signedIn = false
  const router = await show(path)
  const click = userEvent.setup()
  await click.type(await screen.findByLabelText('Name'), 'Ada')
  await click.type(screen.getByLabelText('Email'), user.email)
  await click.type(screen.getByLabelText('Password'), password)
  await click.click(screen.getByRole('button', { name: 'Send code' }))
  expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
  return { router, click, fake }
}

describe('sign-up by email code', () => {
  test('the details screen checks the input, sends only the address, and stays put on a rate limit', async () => {
    fakeSession.signedIn = false
    const fake = signUpServer()
    await show('/auth/sign-up')
    const click = userEvent.setup()
    await click.click(await screen.findByRole('button', { name: 'Send code' }))
    expect(await screen.findByText('Enter your name.')).toBeInTheDocument()
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    expect(fake.sends).toEqual([])

    fake.answerSend(rateLimited)
    await click.type(screen.getByLabelText('Name'), 'Ada')
    await click.type(screen.getByLabelText('Email'), user.email)
    await click.type(screen.getByLabelText('Password'), password)
    await click.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(TOO_MANY_ATTEMPTS)
    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveValue(password)

    fake.answerSend(() => HttpResponse.json({ success: true }))
    await click.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
    expect(screen.getByText(user.email)).toBeInTheDocument()
    // One request per submit, carrying the address only: no name, no password.
    expect(fake.sends).toEqual([
      { email: user.email, type: 'sign-in' },
      { email: user.email, type: 'sign-in' },
    ])
  })

  test('the code screen refuses a bad code, resends, and goes back with the name and email kept', async () => {
    const { click, fake } = await reachCodeScreen('/auth/sign-up')
    const code = screen.getByLabelText('Code')
    expect(code).toHaveAttribute('inputmode', 'numeric')
    expect(code).toHaveAttribute('autocomplete', 'one-time-code')

    await click.type(code, '123')
    await click.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter the 6-digit code from the email.')).toBeInTheDocument()
    expect(fake.signUps).toEqual([])

    for (const [answer, message] of [
      [() => authError(400, 'INVALID_OR_EXPIRED_CODE', 'Invalid or expired code'), SIGN_UP_CODE_REFUSED],
      [rateLimited, TOO_MANY_ATTEMPTS],
      [
        () => authError(500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error'),
        'Creating the account failed. Try again.',
      ],
    ] as const) {
      fake.answerSignUp(answer)
      await click.clear(code)
      await click.type(code, '000000')
      await click.click(screen.getByRole('button', { name: 'Create account' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByRole('heading', { name: 'Enter your code' })).toBeInTheDocument()
    }
    // The details are still there for the next try: each attempt sent all of them.
    expect(fake.signUps).toEqual(Array(3).fill({ name: 'Ada', email: user.email, password, code: '000000' }))

    await click.click(screen.getByRole('button', { name: 'Resend code' }))
    expect(await screen.findByText(/It replaces the previous one/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeDisabled()
    expect(fake.sends).toHaveLength(2)

    await click.click(screen.getByRole('button', { name: 'Use a different email' }))
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Ada')
    expect(screen.getByLabelText('Email')).toHaveValue(user.email)
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })

  test('a right code signs in and lands on the redirect, leaving the password and code nowhere', async () => {
    const logs = [spyOn(console, 'log'), spyOn(console, 'info')]
    const connected = quietMachine(account.id)
    const { router, click } = await reachCodeScreen(`/auth/sign-up?redirect=%2Fm%2F${account.id}`)
    await click.type(screen.getByLabelText('Code'), '123456')
    await click.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/m/${account.id}`))
    // The sign-up page was replaced, so Back doesn't return to it.
    expect(router.history.length).toBe(1)
    await connected

    const { queryClient } = router.options.context
    const places = {
      storage: [Object.entries(localStorage), Object.entries(sessionStorage)],
      location: [router.state.location.href, router.state.location.state, router.history.location],
      queries: queryClient
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state.data]),
      mutations: queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
      logs: logs.flatMap((log) => log.mock.calls),
    }
    const dump = JSON.stringify(places)
    expect(dump).toContain(user.email)
    for (const secret of [password, '123456']) expect(dump).not.toContain(secret)
    expect(screen.queryByDisplayValue(password)).not.toBeInTheDocument()

    // A redirect back into `/auth` lands home instead.
    cleanup()
    const again = await reachCodeScreen('/auth/sign-up?redirect=%2Fauth%2Fsign-in')
    await again.click.type(screen.getByLabelText('Code'), '123456')
    await again.click.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(again.router.state.location.href).toBe('/'))
  })
})
