import { Button, FormError, PasswordField, TextField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { linkClass } from '../components/Centered'
import { leaveIfSignedIn } from '../lib/auth'
import { focusFirstInvalid, shownError, signUpFormOptions, submitOnce } from '../lib/authForms'

/** The search params of `/auth/sign-up`: where to go once signed in, passed on to `/auth/sign-in`. */
interface SignUpSearch {
  redirect?: string
}

export const Route = createFileRoute('/auth/sign-up')({
  validateSearch: (search: Record<string, unknown>): SignUpSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: leaveIfSignedIn,
  component: SignUp,
})

function SignUp() {
  const { redirect: target } = Route.useSearch()
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // The address the verification email went to, once it has. Kept only in this page's state.
  const [sentTo, setSentTo] = useState<string | null>(null)
  const signInSearch = target ? { redirect: target } : {}

  const form = useForm({
    ...signUpFormOptions({ setProblem, onSent: setSentTo }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })

  if (sentTo) {
    return (
      <AuthCard
        title="Check your inbox"
        focusTitle
        footer={
          <Link to="/auth/sign-in" search={signInSearch} className={linkClass}>
            Back to sign in
          </Link>
        }
      >
        <p role="status" className="text-[13px] text-dim">
          We sent a link to <strong className="font-medium text-ink">{sentTo}</strong>. Open it to verify your address,
          then sign in.
        </p>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Create an account"
      footer={
        <p>
          Already have an account?{' '}
          <Link to="/auth/sign-in" search={signInSearch} className={linkClass}>
            Sign in instead
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
              <form.Field name="name">
                {(field) => (
                  <TextField
                    label="Name"
                    name={field.name}
                    autoComplete="name"
                    required
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    error={shownError(field.state.meta, attempts)}
                  />
                )}
              </form.Field>
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
                    autoComplete="new-password"
                    required
                    hint="At least 8 characters."
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
              Create account
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthCard>
  )
}
