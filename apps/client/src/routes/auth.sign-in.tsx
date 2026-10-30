import { Button, FormError, PasswordField, TextField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { linkClass } from '../components/Centered'
import { leaveIfSignedIn, safeRedirect } from '../lib/auth'
import { focusFirstInvalid, shownError, signInFormOptions, submitOnce } from '../lib/authForms'

/** The search params of `/auth/sign-in`: where to go once signed in. */
interface SignInSearch {
  redirect?: string
}

export const Route = createFileRoute('/auth/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: leaveIfSignedIn,
  component: SignIn,
})

function SignIn() {
  const { queryClient } = Route.useRouteContext()
  const { redirect: target } = Route.useSearch()
  const navigate = useNavigate()
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const form = useForm({
    ...signInFormOptions(queryClient, {
      setProblem,
      onSignedIn: () => navigate({ href: safeRedirect(target), replace: true }),
    }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })

  return (
    <AuthCard
      title="Sign in"
      description="Reach your machines and their workspaces from this browser."
      footer={
        <>
          <p>
            New here?{' '}
            <Link to="/auth/sign-up" search={target ? { redirect: target } : {}} className={linkClass}>
              Create an account
            </Link>
          </p>
          <Link to="/auth/verify-email" className={`self-start ${linkClass}`}>
            Didn't get the verification email?
          </Link>
        </>
      }
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submitOnce(form)
        }}
      >
        <form.Subscribe selector={(state) => state.submissionAttempts}>
          {(attempts) => (
            <>
              <form.Field name="email">
                {(field) => (
                  <TextField
                    size="lg"
                    label="Email"
                    name={field.name}
                    type="email"
                    autoComplete="email"
                    required
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    error={shownError(field.state.meta, attempts)}
                  />
                )}
              </form.Field>
              <form.Field name="password">
                {(field) => (
                  <PasswordField
                    size="lg"
                    label="Password"
                    name={field.name}
                    autoComplete="current-password"
                    required
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    error={shownError(field.state.meta, attempts)}
                  />
                )}
              </form.Field>
            </>
          )}
        </form.Subscribe>
        <Link to="/auth/forgot-password" className={`-mt-1 self-end text-xs ${linkClass}`}>
          Forgot your password?
        </Link>
        <FormError message={problem} />
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button size="lg" type="submit" pending={submitting}>
              Sign in
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthCard>
  )
}
