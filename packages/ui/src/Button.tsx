import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { LoaderCircle } from './icons'
import { cn } from './lib/utils'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent/90',
        secondary: 'border border-line bg-bg text-ink hover:bg-raised',
      },
      size: {
        md: 'px-3 py-1.5 text-[13px]',
        // For standalone forms, beside `lg` fields.
        lg: 'h-10 px-4 text-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** True while the action it started is on its way: the button waits and shows a spinner beside its label. */
    pending?: boolean
  }

/** A button in the theme's colours. It is `type="button"` unless told otherwise. */
export function Button({
  variant,
  size,
  pending,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending ? true : undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}
