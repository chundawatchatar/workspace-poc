import { type ReactNode, type Ref, useId } from 'react'
import { cn } from './lib/utils'

/** What a text field takes: plain values and callbacks, so any form library can drive it. */
export interface TextFieldProps {
  /** The visible label, which is also the input's accessible name. */
  label: string
  name: string
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url'
  autoComplete?: string
  value: string
  /** Called with the new text on every keystroke. */
  onChange: (value: string) => void
  onBlur?: () => void
  disabled?: boolean
  required?: boolean
  /** Help shown under the input and read with it. */
  hint?: ReactNode
  /** The problem with the value, shown under the input. Empty or null means it is valid. */
  error?: string | null
  /** Controls inside the input's box after the text, such as a show/hide toggle. They come after it in Tab order. */
  trailing?: ReactNode
  /** `lg` is a roomier field for standalone forms such as sign-in. Its text is 16px on phones so iOS does not zoom. */
  size?: 'md' | 'lg'
  ref?: Ref<HTMLInputElement>
  className?: string
}

/** A labelled input with optional hint and error text, wired up for screen readers. */
export function TextField({
  label,
  name,
  type = 'text',
  autoComplete,
  value,
  onChange,
  onBlur,
  disabled,
  required,
  hint,
  error,
  trailing,
  size = 'md',
  ref,
  className,
}: TextFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-dim">
        {label}
      </label>
      <div
        className={cn(
          'flex items-center rounded-md border bg-bg focus-within:ring-2 focus-within:ring-accent/60',
          error ? 'border-bad' : 'border-line focus-within:border-accent',
          disabled && 'opacity-60',
        )}
      >
        <input
          ref={ref}
          id={id}
          name={name}
          type={type}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint',
            size === 'lg' ? 'px-3 py-2.5 text-base sm:text-sm' : 'px-2.5 py-1.5 text-[13px]',
          )}
        />
        {trailing}
      </div>
      {hint && (
        <p id={hintId} className="text-xs text-dim">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  )
}
