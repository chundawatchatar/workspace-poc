import { createFileRoute, redirect } from '@tanstack/react-router'

// `/auth` has no page of its own, so it opens sign-in, keeping where to go afterwards.
export const Route = createFileRoute('/auth/')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/auth/sign-in', search, replace: true })
  },
})
