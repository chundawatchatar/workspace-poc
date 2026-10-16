import { cva, type VariantProps } from 'class-variance-authority'
import type { LucideIcon } from 'lucide-react'
import { cn } from './lib/utils'

export type { LucideIcon as IconComponent } from 'lucide-react'

/**
 * Every lucide icon, namespaced so names like `Table` or `Badge` do not clash
 * with components. Static access (`Icons.Plus`) keeps unused icons out of the bundle.
 */
export * as Icons from 'lucide-react'

export const iconVariants = cva('shrink-0', {
  variants: {
    size: { sm: 'size-3.5', md: 'size-4', lg: 'size-5' },
  },
  defaultVariants: { size: 'md' },
})

export type IconProps = VariantProps<typeof iconVariants> & {
  icon: LucideIcon
  /** Accessible name; omit for decorative icons next to visible text. */
  label?: string
  className?: string
}

export function Icon({ icon: Component, size, label, className }: IconProps) {
  return (
    <Component
      className={cn(iconVariants({ size }), className)}
      strokeWidth={2}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}
