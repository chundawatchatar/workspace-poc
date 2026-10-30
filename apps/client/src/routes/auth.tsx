import { BrandMark, PRODUCT_FACTS, PRODUCT_HEADLINE, PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/ui'
import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router'
import { AuthWorkspacePreview } from '../components/AuthWorkspacePreview'

// The frame of every page under `/auth`: the product's mark, name and subtitle above the page's card. Sign-in and
// sign-up also get the pitch and a picture of the app beside the card on wide screens; the email pages, opened from a
// link to finish one task, get the card alone. It is never guarded and never leaves when signed in, since an emailed
// link may be opened in either state; each page decides.
export const Route = createFileRoute('/auth')({ component: AuthLayout })

const PITCHED = new Set(['/auth/sign-in', '/auth/sign-up'])

function AuthLayout() {
  const pitched = useLocation({ select: (location) => PITCHED.has(location.pathname) })

  return (
    // The document never scrolls, so the page does, keeping a tall form reachable on a short screen.
    <div className="relative isolate flex h-full flex-col overflow-y-auto bg-bg text-ink">
      <div aria-hidden className="auth-backdrop pointer-events-none fixed inset-0 -z-10" />
      <header
        className={`mx-auto flex w-full max-w-6xl items-center justify-center gap-3 px-6 py-6 sm:px-10 ${pitched ? 'lg:justify-start' : ''}`}
      >
        <BrandMark size={28} intro />
        <div className="flex flex-col">
          <p className="text-sm font-semibold tracking-tight">{PRODUCT_NAME}</p>
          <p className="text-xs text-dim">{PRODUCT_TAGLINE}</p>
        </div>
      </header>
      <div
        className={`mx-auto my-auto grid w-full max-w-6xl items-center gap-14 px-6 pt-4 pb-12 sm:px-10 ${pitched ? 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]' : ''}`}
      >
        {/* The card comes first, so its `h1` leads the page for screen readers; the pitch moves left on wide screens. */}
        <main className={`mx-auto w-full max-w-100 ${pitched ? 'lg:mr-0' : ''}`}>
          <Outlet />
        </main>
        {pitched && (
          <section aria-labelledby="auth-pitch" className="hidden min-w-0 flex-col gap-7 lg:order-first lg:flex">
            <div className="flex flex-col gap-4">
              <p className="flex w-fit items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-dim">
                <span className="size-1.5 rounded-full bg-good" />
                {PRODUCT_FACTS}
              </p>
              <h2 id="auth-pitch" className="text-[1.85rem] leading-[1.12] font-bold tracking-tight text-balance">
                {PRODUCT_HEADLINE.lead} <span className="text-accent">{PRODUCT_HEADLINE.accent}</span>
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-dim">
                Split panes, tabs and real shells run on your own machine and live in your browser. When an agent
                finishes or asks a question, the pane tells you.
              </p>
            </div>
            <AuthWorkspacePreview />
          </section>
        )}
      </div>
    </div>
  )
}
