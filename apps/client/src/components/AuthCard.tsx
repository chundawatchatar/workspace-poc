import { type ReactNode, useEffect, useRef } from 'react'

/**
 * The card of one page under `/auth`: its heading, the only `h1` on the page, then the body and links to the other
 * pages. With `focusTitle`, focus moves to the heading when the card appears, so a screen reader announces a card
 * that replaced the form.
 */
export function AuthCard({
  title,
  children,
  footer,
  focusTitle = false,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  focusTitle?: boolean
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusTitle) headingRef.current?.focus()
  }, [focusTitle])
  return (
    <div className="flex w-full flex-col gap-5 rounded-lg border border-line bg-panel p-6">
      <h1 ref={headingRef} tabIndex={focusTitle ? -1 : undefined} className="text-lg font-semibold outline-none">
        {title}
      </h1>
      {children}
      {footer && <div className="flex flex-col gap-1 text-[13px] text-dim">{footer}</div>}
    </div>
  )
}
