import { createFileRoute } from '@tanstack/react-router'
import { ComingSoonSettings } from '../../components/settings/SettingsSection'

export const Route = createFileRoute('/settings/notifications')({
  component: () => <ComingSoonSettings title="Notifications" />,
})
