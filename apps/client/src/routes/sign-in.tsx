import { Button, FormError, PasswordField, TextField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { linkClass } from '../components/Centered'
import { leaveIfSignedIn, safeRedirect, signInWithEmail } from '../lib/auth'
import { focusFirstInvalid, shownError, signInSchema, submitOnce } from '../lib/authForms'

/** The search params of `/sign-in`: where to go once signed in. */
interface SignInSearch {
  redirect?: string
}

export const Route = createFileRoute('/sign-in')({
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
    defaultValues: { email: '', password: '' },
    validators: { onChange: signInSchema, onBlur: signInSchema },
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
    onSubmit: async ({ value }) => {
      const { email, password } = signInSchema.parse(value)
      const message = await signInWithEmail(queryClient, email, password).catch(() => 'Signing in failed. Try again.')
      setProblem(message)
      if (!message) await navigate({ href: safeRedirect(target), replace: true })
    },
  })

  return (
    <AuthCard
      title="Sign in"
      footer={
        <p>
          New here?{' '}
          <Link to="/sign-up" search={target ? { redirect: target } : {}} className={linkClass}>
            Create an account
          </Link>
        </p>
      }
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-3"
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
        <FormError message={problem} />
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" pending={submitting}>
              Sign in
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthCard>
  )
}
