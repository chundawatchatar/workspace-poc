import { createFileRoute } from '@tanstack/react-router'
import { SettingsLayout } from '../../components/settings/SettingsLayout'
import { requireSession } from '../../lib/auth'

// Every settings page is for the signed-in account, so the whole section is guarded here.
export const Route = createFileRoute('/settings')({ beforeLoad: requireSession, component: SettingsLayout })
