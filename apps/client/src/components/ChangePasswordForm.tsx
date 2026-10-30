import { Button, FormError, PasswordField } from '@orch/ui'
import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { changePasswordFormOptions, focusFirstInvalid, shownError, submitOnce } from '../lib/authForms'

const fields = [
  { name: 'currentPassword', label: 'Current password', autoComplete: 'current-password', hint: undefined },
  { name: 'newPassword', label: 'New password', autoComplete: 'new-password', hint: 'At least 8 characters.' },
  { name: 'confirmPassword', label: 'Confirm new password', autoComplete: 'new-password', hint: undefined },
] as const

/** Changes the password and signs out every other device; this one stays signed in. */
export function ChangePasswordForm() {
  const queryClient = useQueryClient()
  const formRef = useRef<HTMLFormElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const form = useForm({
    ...changePasswordFormOptions(queryClient, {
      setProblem: (message) => {
        setProblem(message)
        if (message !== null) setChanged(false)
      },
      onChanged: () => setChanged(true),
    }),
    onSubmitInvalid: ({ formApi }) => focusFirstInvalid(formRef.current, formApi.state.fieldMeta),
  })

  return (
    <form
      ref={formRef}
      noValidate
      className="flex max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setChanged(false)
        submitOnce(form)
      }}
    >
      <form.Subscribe selector={(state) => state.submissionAttempts}>
        {(attempts) =>
          fields.map(({ name, label, autoComplete, hint }) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <PasswordField
                  label={label}
                  name={field.name}
                  autoComplete={autoComplete}
                  required
                  hint={hint}
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                  error={shownError(field.state.meta, attempts)}
                />
              )}
            </form.Field>
          ))
        }
      </form.Subscribe>
      <FormError message={problem} />
      {changed && (
        <p role="status" className="text-[13px] text-good">
          Your password has changed, and every other device has been signed out.
        </p>
      )}
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(submitting) => (
          <Button type="submit" pending={submitting} className="self-start">
            Change password
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}
