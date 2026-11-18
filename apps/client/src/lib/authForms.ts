import { formOptions } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { changePassword } from './accountSessions'
import {
  EXPIRED_LINK,
  requestPasswordReset,
  resetPassword,
  sendSignUpCode,
  signInWithEmail,
  signUpWithCode,
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

/** What the first sign-up screen checks. */
export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.'),
  email,
  password: newPassword,
})

/** What the second sign-up screen checks: the code from the email, exactly 6 digits. */
export const signUpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'Enter the code from the email.')
    .regex(/^\d{6}$/, 'Enter the 6-digit code from the email.'),
})

/** What the form that only asks for an address checks: a forgotten password. */
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

/** What the first sign-up screen hands to the second once the code is on its way, kept only in the page's state. */
export interface SignUpDetails {
  name: string
  email: string
  password: string
}

/**
 * The first sign-up screen's options, starting from `initial` (a name and email kept from an earlier try, and never
 * a password). A submit clears the last `setProblem` message as it starts, asks the server to email a code, and
 * reports a refusal through `setProblem`, keeping the values, or calls `onCodeSent` with the checked details.
 */
export function signUpFormOptions(
  initial: { name: string; email: string },
  {
    setProblem,
    onCodeSent,
  }: { setProblem: (message: string | null) => void; onCodeSent: (details: SignUpDetails) => void },
) {
  return formOptions({
    defaultValues: { name: initial.name, email: initial.email, password: '' },
    validators: { onChange: signUpSchema, onBlur: signUpSchema },
    onSubmit: async ({ value }) => {
      setProblem(null)
      const details = signUpSchema.parse(value)
      const message = await sendSignUpCode(details.email).catch(() => 'Sending the code failed. Try again.')
      if (message) setProblem(message)
      else onCodeSent(details)
    },
  })
}

/**
 * The second sign-up screen's options, for the `details` the first one checked. A submit clears the last
 * `setProblem` message as it starts, then reports a refusal through `setProblem`, keeping the code, or empties the
 * form and calls `onSignedUp` once the account exists and is signed in.
 */
export function signUpCodeFormOptions(
  queryClient: QueryClient,
  details: SignUpDetails,
  { setProblem, onSignedUp }: { setProblem: (message: string | null) => void; onSignedUp: () => Promise<unknown> },
) {
  return formOptions({
    defaultValues: { code: '' },
    validators: { onChange: signUpCodeSchema, onBlur: signUpCodeSchema },
    onSubmit: async ({ value, formApi }) => {
      setProblem(null)
      const { code } = signUpCodeSchema.parse(value)
      const message = await signUpWithCode(queryClient, { ...details, code }).catch(
        () => 'Creating the account failed. Try again.',
      )
      if (message) {
        setProblem(message)
        return
      }
      formApi.reset()
      await onSignedUp()
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
