import { BrandMark, PRODUCT_NAME, PRODUCT_TAGLINE } from '@orch/ui'
import { createFileRoute, Outlet } from '@tanstack/react-router'

// The frame of every page under `/auth`: the product's mark, name and subtitle above the page's card. It is never
// guarded and never leaves when signed in, since an emailed link may be opened in either state; each page decides.
export const Route = createFileRoute('/auth')({ component: AuthLayout })

function AuthLayout() {
  return (
    // The document never scrolls, so the page does, keeping a tall form reachable on a short screen.
    <main className="flex h-full flex-col overflow-y-auto bg-bg p-6 text-ink">
      <div className="m-auto flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <BrandMark size={36} />
          <p className="text-base font-semibold tracking-tight">{PRODUCT_NAME}</p>
          <p className="text-[13px] text-dim">{PRODUCT_TAGLINE}</p>
        </div>
        <Outlet />
      </div>
    </main>
  )
}
