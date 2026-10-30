import { Button, FormError, PasswordField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { linkClass } from '../components/Centered'
import { EXPIRED_LINK } from '../lib/auth'
import { focusFirstInvalid, resetPasswordFormOptions, shownError, submitOnce } from '../lib/authForms'
import { takeEmailLinkToken, useEmailLinkArrivals } from '../lib/emailLink'

// No `leaveIfSignedIn`: an emailed link may be opened while signed in, and the reset then signs that session out.
export const Route = createFileRoute('/auth/reset-password')({ component: ResetPasswordPage })

// A new link opened on this page starts it afresh.
function ResetPasswordPage() {
  return <ResetPassword key={useEmailLinkArrivals()} />
}

function ResetPassword() {
  // Taken once, on the first render, so the token is never read again from anywhere.
  const [token] = useState(() => takeEmailLinkToken('reset-password'))
  const [outcome, setOutcome] = useState<'form' | 'expired' | 'changed'>(token ? 'form' : 'expired')

  if (outcome === 'changed') {
    return (
      <AuthCard title="Password changed" focusTitle>
        <p role="status" className="text-[13px] text-dim">
          Your new password is set, and every device that was signed in has been signed out.
        </p>
        <Link to="/auth/sign-in" className={`self-start ${linkClass}`}>
          Sign in with your new password
        </Link>
      </AuthCard>
    )
  }
  if (outcome === 'expired' || !token) {
    return (
      <AuthCard
        title="Reset your password"
        focusTitle={token !== null}
        footer={
          <Link to="/auth/sign-in" className={linkClass}>
            Back to sign in
          </Link>
        }
      >
        <FormError message={EXPIRED_LINK} />
        <Link to="/auth/forgot-password" className={`self-start ${linkClass}`}>
          Send a new reset link
        </Link>
      </AuthCard>
    )
  }
  return (
    <NewPasswordForm token={token} onExpired={() => setOutcome('expired')} onChanged={() => setOutcome('changed')} />
  )
}

/** The form that sets a new password with the link's `token`. */
function NewPasswordForm({
  token,
  onExpired,
  onChanged,
}: {
  token: string
  onExpired: () => void
  onChanged: () => void
}) {
  const { queryClient } = Route.useRouteContext()
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const form = useForm({
    ...resetPasswordFormOptions(queryClient, token, { setProblem, onExpired, onChanged }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })

  return (
    <AuthCard
      title="Choose a new password"
      footer={
        <Link to="/auth/sign-in" className={linkClass}>
          Back to sign in
        </Link>
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
            <form.Field name="password">
              {(field) => (
                <PasswordField
                  size="lg"
                  label="New password"
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
          )}
        </form.Subscribe>
        <FormError message={problem} />
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button size="lg" type="submit" pending={submitting}>
              Change password
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthCard>
  )
}
