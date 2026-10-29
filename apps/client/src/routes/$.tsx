import { createFileRoute } from '@tanstack/react-router'
import { PageNotFound } from '../components/PageNotFound'

// Unknown paths match this route rather than leaving the root not found. The prerendered shell only has the root,
// so a not-found root would render differently from the shell and fail hydration; a child route renders after it.
export const Route = createFileRoute('/$')({ component: PageNotFound })
