import { createFileRoute, redirect } from '@tanstack/react-router'

// `/settings` has no page of its own, so it opens the first section.
export const Route = createFileRoute('/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/account', replace: true })
  },
})
