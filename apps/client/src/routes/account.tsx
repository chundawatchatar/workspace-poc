import { createFileRoute } from '@tanstack/react-router'
import { AccountPage } from '../components/AccountPage'
import { requireSession } from '../lib/auth'

export const Route = createFileRoute('/account')({ beforeLoad: requireSession, component: AccountPage })
