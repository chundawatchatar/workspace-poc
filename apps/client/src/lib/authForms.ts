import { formOptions } from '@tanstack/react-form'
import type { QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { signInWithEmail, signUpWithEmail } from './auth'

// The rules and helpers the sign-in and sign-up forms share. The server stays the authority; these only catch
// mistakes before a request is sent.

const email = z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.'))

/** What the sign-in form checks: an email address and a password. */
export const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
})

/** What the sign-up form checks. The password limits are Better Auth's defaults. */
export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.'),
  email,
  password: z.string().min(8, 'Use at least 8 characters.').max(128, 'Use at most 128 characters.'),
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
export function submitOnce(form: { state: { isSubmitting: boolean }; handleSubmit: () => Promise<unknown> }) {
  if (form.state.isSubmitting) return
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
