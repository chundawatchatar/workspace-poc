import { markSvg } from './brand'
import { cn } from './lib/utils'

/**
 * The product's mark, inline and hidden from assistive technology, since the product's name always goes with it. It
 * is drawn in `currentColor`, which is the theme's accent unless `className` sets another text colour.
 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 text-accent', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The markup is `markSvg`'s output for constant values, with no user input.
      dangerouslySetInnerHTML={{ __html: markSvg({ color: 'currentColor', size }) }}
    />
  )
}
