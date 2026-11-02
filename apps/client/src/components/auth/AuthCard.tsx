import { type ReactNode, useEffect, useRef } from 'react'

/**
 * The card of one page under `/auth`: its heading, the only `h1` on the page, then the body and links to the other
 * pages. With `focusTitle`, focus moves to the heading when the card appears, so a screen reader announces a card
 * that replaced the form.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
  focusTitle = false,
}: {
  title: string
  /** One line under the heading saying what the page is for. */
  description?: string
  children: ReactNode
  footer?: ReactNode
  focusTitle?: boolean
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusTitle) headingRef.current?.focus()
  }, [focusTitle])
  return (
    <section className="w-full overflow-hidden rounded-lg border border-line bg-panel shadow-sm shadow-black/5">
      <div className="flex flex-col gap-5 p-6 sm:p-7">
        <div className="flex flex-col gap-1.5">
          <h1
            ref={headingRef}
            tabIndex={focusTitle ? -1 : undefined}
            className="text-xl font-semibold tracking-tight outline-none"
          >
            {title}
          </h1>
          {description && <p className="text-[13px] text-dim">{description}</p>}
        </div>
        {children}
      </div>
      {footer && (
        <div className="flex flex-col gap-1.5 border-t border-line bg-bg/40 px-6 py-4 text-[13px] text-dim sm:px-7">
          {footer}
        </div>
      )}
    </section>
  )
}
