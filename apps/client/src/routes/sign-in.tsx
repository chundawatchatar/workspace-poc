import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { Centered } from '../components/Centered'
import { safeRedirect, sessionQuery, signInWithEmail } from '../lib/auth'

/** The search params of `/sign-in`: where to go once signed in. */
interface SignInSearch {
  redirect?: string
}

// Never guarded, or a signed-out user could never reach it.
export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context, search }) => {
    if (import.meta.env.SSR) return
    // A session that can't be read leaves the form up, where signing in reports the problem.
    const user = await context.queryClient.ensureQueryData(sessionQuery).catch(() => null)
    if (user) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: SignIn,
})

function SignIn() {
  const { queryClient } = Route.useRouteContext()
  const { redirect: target } = Route.useSearch()
  const navigate = useNavigate()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    const problem = await signInWithEmail(queryClient, String(form.get('email')), String(form.get('password'))).catch(
      () => 'Signing in failed. Try again.',
    )
    setBusy(false)
    setMessage(problem)
    if (!problem) await navigate({ href: safeRedirect(target), replace: true })
  }

  return (
    <Centered>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <label className="flex flex-col">
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="flex flex-col">
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={busy}>
          Sign in
        </button>
        {message && <p role="alert">{message}</p>}
      </form>
    </Centered>
  )
}
