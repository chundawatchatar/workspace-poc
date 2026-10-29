import { useState } from 'react'
import { Eye, EyeOff } from './icons'
import { TextField, type TextFieldProps } from './TextField'

/** What a password field takes: a text field's props, and optionally who decides whether the password shows. */
export interface PasswordFieldProps extends Omit<TextFieldProps, 'type' | 'trailing'> {
  /** True when the password shows as plain text. Without it, the field keeps this itself. */
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
}

/** A password input with a button that shows or hides what was typed. */
export function PasswordField({ revealed, onRevealedChange, ...props }: PasswordFieldProps) {
  const [ownRevealed, setOwnRevealed] = useState(false)
  const shown = revealed ?? ownRevealed
  const Glyph = shown ? EyeOff : Eye

  const toggle = (
    <button
      type="button"
      aria-label={shown ? 'Hide password' : 'Show password'}
      aria-pressed={shown}
      disabled={props.disabled}
      onClick={() => {
        setOwnRevealed(!shown)
        onRevealedChange?.(!shown)
      }}
      className="mr-1 rounded p-1 text-dim outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Glyph className="size-4" aria-hidden />
    </button>
  )

  return <TextField {...props} type={shown ? 'text' : 'password'} trailing={toggle} />
}
