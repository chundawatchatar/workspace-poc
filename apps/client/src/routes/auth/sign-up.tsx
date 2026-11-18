import { Button, FormError, PasswordField, TextField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useRef, useState } from 'react'
import { AuthCard } from '../../components/auth/AuthCard'
import { SignUpCode } from '../../components/auth/SignUpCode'
import { linkClass } from '../../components/Centered'
import { leaveIfSignedIn, safeRedirect } from '../../lib/auth'
import { focusFirstInvalid, type SignUpDetails, shownError, signUpFormOptions, submitOnce } from '../../lib/authForms'

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

// Two screens on one route: the details, then the emailed code. The details, password included, live only in this
// component's state, so leaving the page drops them, and none of them enters the URL, storage or the query cache.
function SignUp() {
  const { queryClient } = Route.useRouteContext()
  const { redirect: target } = Route.useSearch()
  const navigate = useNavigate()
  // What the code screen creates the account from, once a code is on its way.
  const [details, setDetails] = useState<SignUpDetails | null>(null)
  // The name and email the details screen starts from when someone goes back to change the address.
  const [kept, setKept] = useState({ name: '', email: '' })
  const signInSearch = target ? { redirect: target } : {}
  const footer = (
    <p>
      Already have an account?{' '}
      <Link to="/auth/sign-in" search={signInSearch} className={linkClass}>
        Sign in instead
      </Link>
    </p>
  )

  if (details) {
    return (
      <SignUpCode
        queryClient={queryClient}
        details={details}
        onSignedUp={() => navigate({ href: safeRedirect(target), replace: true })}
        onChangeEmail={() => {
          setKept({ name: details.name, email: details.email })
          setDetails(null)
        }}
        footer={footer}
      />
    )
  }
  return <SignUpDetailsForm initial={kept} onCodeSent={setDetails} footer={footer} />
}

/** The first screen: name, email and password. Sending the code hands the checked details to `onCodeSent`. */
function SignUpDetailsForm({
  initial,
  onCodeSent,
  footer,
}: {
  initial: { name: string; email: string }
  onCodeSent: (details: SignUpDetails) => void
  footer: ReactNode
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const form = useForm({
    ...signUpFormOptions(initial, { setProblem, onCodeSent }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })

  return (
    <AuthCard title="Create an account" description="One account for every machine you connect." footer={footer}>
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
              <form.Field name="name">
                {(field) => (
                  <TextField
                    size="lg"
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
            <Button size="lg" type="submit" pending={submitting}>
              Send code
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthCard>
  )
}
