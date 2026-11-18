import { Button, FormError, TextField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { sendSignUpCode } from '../../lib/auth'
import {
  focusFirstInvalid,
  type SignUpDetails,
  shownError,
  signUpCodeFormOptions,
  submitOnce,
} from '../../lib/authForms'
import { linkClass } from '../Centered'
import { AuthCard } from './AuthCard'

/** How long "Resend code" stays off after it sent a code, so one click sends one email. */
export const RESEND_COOLDOWN_MS = 30_000

/**
 * The second sign-up screen: the code emailed to `details.email`, which creates the account. "Resend code" asks for
 * a new code, and "Use a different email" calls `onChangeEmail` to go back to the first screen. The details stay in
 * the page's state, never in the URL or storage.
 */
export function SignUpCode({
  queryClient,
  details,
  onSignedUp,
  onChangeEmail,
  footer,
}: {
  queryClient: QueryClient
  details: SignUpDetails
  onSignedUp: () => Promise<unknown>
  onChangeEmail: () => void
  footer: ReactNode
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const form = useForm({
    ...signUpCodeFormOptions(queryClient, details, { setProblem, onSignedUp }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })
  const resend = useResend(details.email, setProblem)

  return (
    <AuthCard
      title="Enter your code"
      focusTitle
      footer={
        <>
          <button type="button" className={`self-start ${linkClass}`} onClick={onChangeEmail}>
            Use a different email
          </button>
          {footer}
        </>
      }
    >
      <p className="text-[13px] text-dim">
        Enter the code we sent to <strong className="font-medium text-ink">{details.email}</strong>. It can take a
        minute to arrive.
      </p>
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
            <form.Field name="code">
              {(field) => (
                <TextField
                  size="lg"
                  label="Code"
                  name={field.name}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
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
              Create account
            </Button>
          )}
        </form.Subscribe>
        <Button
          size="lg"
          variant="secondary"
          pending={resend.pending}
          disabled={resend.coolingDown}
          onClick={() => void resend.send()}
        >
          Resend code
        </Button>
        {resend.sent && (
          <p role="status" className="text-[13px] text-dim">
            We sent a new code. It replaces the previous one, and you can ask again after 30 seconds.
          </p>
        )}
      </form>
    </AuthCard>
  )
}

/**
 * Sends a new code to `email` on `send`, then keeps the button off for `RESEND_COOLDOWN_MS`. A failure goes to
 * `setProblem`, and the button can be used again at once.
 */
function useResend(email: string, setProblem: (message: string | null) => void) {
  const [pending, setPending] = useState(false)
  const [coolingDown, setCoolingDown] = useState(false)
  const [sent, setSent] = useState(false)
  // A second click can land before React has disabled the button.
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function send() {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setProblem(null)
    const message = await sendSignUpCode(email).catch(() => 'Sending the code failed. Try again.')
    setPending(false)
    if (message) {
      busy.current = false
      setProblem(message)
      return
    }
    setSent(true)
    setCoolingDown(true)
    timer.current = setTimeout(() => {
      busy.current = false
      setCoolingDown(false)
    }, RESEND_COOLDOWN_MS)
  }

  return { pending, coolingDown, sent, send }
}
