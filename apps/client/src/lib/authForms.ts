import { formOptions } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { changePassword } from './accountSessions'
import {
  EXPIRED_LINK,
  requestPasswordReset,
  resendVerificationEmail,
  resetPassword,
  signInWithEmail,
  signUpWithEmail,
} from './auth'

// The rules and helpers the forms under `/auth` share. The server stays the authority; these only catch
// mistakes before a request is sent.

const email = z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.'))

/** What the sign-in form checks: an email address and a password. */
export const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
})

// A new password. The limits are Better Auth's defaults.
const newPassword = z.string().min(8, 'Use at least 8 characters.').max(128, 'Use at most 128 characters.')

/** What the sign-up form checks. */
export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.'),
  email,
  password: newPassword,
})

/** What the forms that only ask for an address check: resending the verification email, and a forgotten password. */
export const emailSchema = z.object({ email })

/** What the reset-password form checks: the new password, with the same limits as sign-up. */
export const resetPasswordSchema = z.object({ password: newPassword })

/**
 * What the change-password form checks: the current password, a new one with the same limits as sign-up, and a
 * confirmation that must match it.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword,
    confirmPassword: z.string(),
  })
  .refine((value) => value.confirmPassword === value.newPassword, {
    message: 'The passwords do not match.',
    path: ['confirmPassword'],
    // Zod skips an object's refinements while any field fails; this one only needs the two passwords.
    when: ({ value }) => {
      const { newPassword, confirmPassword } = (value ?? {}) as Record<string, unknown>
      return typeof newPassword === 'string' && typeof confirmPassword === 'string'
    },
  })

/** What a form field reports about itself, as TanStack Form keeps it. */
interface FieldMeta {
  isBlurred: boolean
  errors: readonly unknown[]
}

/**
 * The message to show under a field, or null. A field says nothing until it has been left or the form submitted,
 * so nobody is told off before they have typed.
 */
export function shownError(meta: FieldMeta, submissionAttempts: number): string | null {
  if (!meta.isBlurred && submissionAttempts === 0) return null
  const first = meta.errors.find(Boolean)
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && 'message' in first && typeof first.message === 'string') {
    return first.message
  }
  return null
}

/** Submits `form` unless a submit is already on its way, so pressing Enter twice sends one request. */
export function submitOnce(form: {
  state: { isSubmitting: boolean }
  handleSubmit: () => Promise<unknown>
  validate: (cause: 'blur') => unknown
}) {
  if (form.state.isSubmitting) return
  // A blur error stays until its field is left again, and Enter submits without leaving the field. Checking on blur
  // first replaces errors from a field left while another was still empty. The Zod schemas run synchronously.
  form.validate('blur')
  void form.handleSubmit()
}

/** Moves focus to the first control in `element` whose field has an error, in the order they appear. */
export function focusFirstInvalid(
  element: HTMLFormElement | null,
  fieldMeta: Partial<Record<string, { errors: readonly unknown[] } | undefined>>,
) {
  for (const control of Array.from(element?.elements ?? [])) {
    const name = (control as HTMLInputElement).name
    if (name && fieldMeta[name]?.errors.some(Boolean)) {
      ;(control as HTMLInputElement).focus()
      return
    }
  }
}

/**
 * The sign-in form's options. A submit clears the last `setProblem` message as it starts, then reports the server's
 * refusal through `setProblem`, or calls `onSignedIn`.
 */
export function signInFormOptions(
  queryClient: QueryClient,
  { setProblem, onSignedIn }: { setProblem: (message: string | null) => void; onSignedIn: () => Promise<unknown> },
) {
  return formOptions({
    defaultValues: { email: '', password: '' },
    validators: { onChange: signInSchema, onBlur: signInSchema },
    onSubmit: async ({ value }) => {
      setProblem(null)
      const { email, password } = signInSchema.parse(value)
      const message = await signInWithEmail(queryClient, email, password).catch(() => 'Signing in failed. Try again.')
      if (message) setProblem(message)
      else await onSignedIn()
    },
  })
}

/**
 * The sign-up form's options. A submit clears the last `setProblem` message as it starts, then reports the server's
 * refusal through `setProblem`, or empties the form, so the password is gone, and calls `onSent` with the address.
 */
export function signUpFormOptions({
  setProblem,
  onSent,
}: {
  setProblem: (message: string | null) => void
  onSent: (email: string) => void
}) {
  return formOptions({
    defaultValues: { name: '', email: '', password: '' },
    validators: { onChange: signUpSchema, onBlur: signUpSchema },
    onSubmit: async ({ value, formApi }) => {
      setProblem(null)
      const { name, email, password } = signUpSchema.parse(value)
      const message = await signUpWithEmail(email, password, name).catch(
        () => 'Creating the account failed. Try again.',
      )
      if (message) {
        setProblem(message)
        return
      }
      formApi.reset()
      onSent(email)
    },
  })
}

/**
 * The options of a form that emails a link to one address through `send`. A submit clears the last `setProblem`
 * message as it starts, then reports a failure through `setProblem`, or empties the form and calls `onSent` with the
 * address. The server answers the same whether or not the address has an account, so `onSent` can't tell either.
 */
function emailLinkFormOptions(
  send: (email: string) => Promise<string | null>,
  { setProblem, onSent }: { setProblem: (message: string | null) => void; onSent: (email: string) => void },
) {
  return formOptions({
    defaultValues: { email: '' },
    validators: { onChange: emailSchema, onBlur: emailSchema },
    onSubmit: async ({ value, formApi }) => {
      setProblem(null)
      const { email } = emailSchema.parse(value)
      const message = await send(email).catch(() => 'Sending the email failed. Try again.')
      if (message) {
        setProblem(message)
        return
      }
      formApi.reset()
      onSent(email)
    },
  })
}

/** The options of the form that sends a new verification link; see `emailLinkFormOptions`. */
export function resendVerificationFormOptions(callbacks: Parameters<typeof emailLinkFormOptions>[1]) {
  return emailLinkFormOptions(resendVerificationEmail, callbacks)
}

/** The options of the form that sends a password-reset link; see `emailLinkFormOptions`. */
export function forgotPasswordFormOptions(callbacks: Parameters<typeof emailLinkFormOptions>[1]) {
  return emailLinkFormOptions(requestPasswordReset, callbacks)
}

/**
 * The reset-password form's options for the link's `token`. A submit clears the last `setProblem` message as it
 * starts. A refused token calls `onExpired`, another failure goes to `setProblem`, and success empties the form, so
 * the password is gone, and calls `onChanged`.
 */
export function resetPasswordFormOptions(
  queryClient: QueryClient,
  token: string,
  {
    setProblem,
    onExpired,
    onChanged,
  }: { setProblem: (message: string | null) => void; onExpired: () => void; onChanged: () => void },
) {
  return formOptions({
    defaultValues: { password: '' },
    validators: { onChange: resetPasswordSchema, onBlur: resetPasswordSchema },
    onSubmit: async ({ value, formApi }) => {
      setProblem(null)
      const { password } = resetPasswordSchema.parse(value)
      const message = await resetPassword(queryClient, token, password).catch(
        () => 'Changing the password failed. Try again.',
      )
      if (message === EXPIRED_LINK) {
        onExpired()
        return
      }
      if (message) {
        setProblem(message)
        return
      }
      formApi.reset()
      onChanged()
    },
  })
}

/**
 * The change-password form's options. A submit clears the last `setProblem` message as it starts, then reports a
 * refusal through `setProblem`, or empties the form, so no password is left in it, and calls `onChanged`.
 */
export function changePasswordFormOptions(
  queryClient: QueryClient,
  { setProblem, onChanged }: { setProblem: (message: string | null) => void; onChanged: () => void },
) {
  return formOptions({
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validators: { onChange: changePasswordSchema, onBlur: changePasswordSchema },
    onSubmit: async ({ value, formApi }) => {
      setProblem(null)
      const { currentPassword, newPassword } = changePasswordSchema.parse(value)
      const message = await changePassword(queryClient, currentPassword, newPassword).catch(
        () => 'Changing the password failed. Try again.',
      )
      if (message) {
        setProblem(message)
        return
      }
      formApi.reset()
      onChanged()
    },
  })
}
