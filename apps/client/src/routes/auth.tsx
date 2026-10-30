import { BrandMark, PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/ui'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AuthWorkspacePreview } from '../components/AuthWorkspacePreview'

// The frame of every page under `/auth`: the product's mark, name and subtitle, the page's card and, on wide screens,
// a picture of the app beside it. It is never guarded and never leaves when signed in, since an emailed link may be
// opened in either state; each page decides.
export const Route = createFileRoute('/auth')({ component: AuthLayout })

function AuthLayout() {
  return (
    // The document never scrolls, so the page does, keeping a tall form reachable on a short screen.
    <main className="relative isolate flex h-full flex-col overflow-y-auto bg-bg bg-radial-[at_15%_45%] from-accent/5 to-transparent to-60% text-ink">
      {/* The marketing site's dot grid, fading out from behind the picture of the app. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(var(--color-line)_1px,transparent_1px)] bg-size-[22px_22px] [mask-image:radial-gradient(ellipse_at_25%_50%,black,transparent_65%)]"
      />
      <header className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 py-6 sm:px-10">
        <BrandMark size={28} />
        <div className="flex flex-col">
          <p className="text-sm font-semibold tracking-tight">{PRODUCT_NAME}</p>
          <p className="text-xs text-dim">{PRODUCT_TAGLINE}</p>
        </div>
      </header>
      <div className="mx-auto my-auto grid w-full max-w-6xl items-center gap-14 px-6 pt-4 pb-12 sm:px-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {/* The card comes first, so its `h1` leads the page for screen readers; the picture moves left on wide screens. */}
        <div className="mx-auto w-full max-w-[400px] lg:mr-0">
          <Outlet />
        </div>
        <section aria-label={`About ${PRODUCT_NAME}`} className="hidden min-w-0 flex-col gap-7 lg:order-first lg:flex">
          <div className="flex flex-col gap-4">
            <p className="flex w-fit items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-dim">
              <span className="size-1.5 rounded-full bg-good" />
              Free and open source · macOS and Linux · any browser
            </p>
            <p className="text-[2.1rem] leading-[1.1] font-bold tracking-tight text-balance">
              Run every agent at once. <span className="text-accent">Know which one needs you.</span>
            </p>
            <p className="max-w-md text-sm leading-relaxed text-dim">
              Split panes, tabs and real shells run on your own machine and live in your browser. When an agent finishes
              or asks a question, the pane tells you.
            </p>
          </div>
          <AuthWorkspacePreview />
        </section>
      </div>
    </main>
  )
}
