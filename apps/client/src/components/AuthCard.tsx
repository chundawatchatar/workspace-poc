import type { ReactNode } from 'react'

/** The frame of the sign-in and sign-up pages: one heading, the form, and links to the other pages under it. */
export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    // The document never scrolls, so the page does, keeping a tall form reachable on a short screen.
    <main className="flex h-full flex-col overflow-y-auto bg-bg p-6 text-ink">
      <div className="m-auto flex w-full max-w-sm flex-col gap-5 rounded-lg border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
        {footer && <div className="flex flex-col gap-1 text-[13px] text-dim">{footer}</div>}
      </div>
    </main>
  )
}
