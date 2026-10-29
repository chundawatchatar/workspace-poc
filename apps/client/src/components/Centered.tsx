import type { ReactNode } from 'react'

/** A visible focus ring for keyboard users, in the theme's accent colour. */
export const focusClass = 'rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60'
export const linkClass = `text-accent hover:underline ${focusClass}`

/** A short message in the middle of the page. */
export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-dim">{children}</div>
}
