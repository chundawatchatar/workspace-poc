import { Button, FormError, TextField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { useRef, useState } from 'react'
import {
  focusFirstInvalid,
  forgotPasswordFormOptions,
  resendVerificationFormOptions,
  shownError,
  submitOnce,
} from '../lib/authForms'

/**
 * A one-field form that emails a link to the address typed in: a new verification link (`resend`) or a
 * password-reset link (`forgot`). It calls `onSent` with the address once the server has answered.
 */
export function EmailLinkForm({
  kind,
  submitLabel,
  onSent,
}: {
  kind: 'resend' | 'forgot'
  submitLabel: string
  onSent: (email: string) => void
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const options = kind === 'resend' ? resendVerificationFormOptions : forgotPasswordFormOptions
  const form = useForm({
    ...options({ setProblem, onSent }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })

  return (
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
        )}
      </form.Subscribe>
      <FormError message={problem} />
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(submitting) => (
          <Button size="lg" type="submit" pending={submitting}>
            {submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}
