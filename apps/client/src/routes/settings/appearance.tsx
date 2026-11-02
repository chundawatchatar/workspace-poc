import { createFileRoute } from '@tanstack/react-router'
import { ComingSoonSettings } from '../../components/settings/SettingsSection'

export const Route = createFileRoute('/settings/appearance')({
  component: () => <ComingSoonSettings title="Appearance" />,
})
