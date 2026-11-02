import { Pencil } from '@orch/ui/icons'
import { useQuery } from '@tanstack/react-query'
import { sessionQuery } from '../../lib/auth'
import { focusClass } from '../Centered'
import { SettingsCard, SettingsRow, SettingsSection, SettingsTitle } from './SettingsSection'

// A skeleton: the values are real, but editing, the plan and deleting the account aren't built yet, so their
// controls are disabled.

function EditButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={`Edit ${label}`}
      title="Coming soon"
      disabled
      className={`rounded p-1 text-faint hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-60 ${focusClass}`}
    >
      <Pencil size={13} />
    </button>
  )
}

/** The account settings page: who is signed in, the plan, and deleting the account. */
export function AccountSettings() {
  const user = useQuery(sessionQuery).data
  return (
    <>
      <SettingsTitle>Account</SettingsTitle>
      <SettingsSection title="General">
        <SettingsCard>
          <SettingsRow label="Name">
            <span className="truncate">{user?.name}</span>
            <EditButton label="name" />
          </SettingsRow>
          <SettingsRow label="Email">
            <span className="truncate">{user?.email}</span>
            <EditButton label="email" />
          </SettingsRow>
          <SettingsRow label="Plan">Free</SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <SettingsCard>
        <SettingsRow label="Delete account" description="Removes your account and unlinks all your machines.">
          <button
            type="button"
            title="Coming soon"
            disabled
            className={`rounded-md bg-bad/10 px-3 py-1.5 text-[13px] text-bad hover:bg-bad/20 disabled:opacity-60 ${focusClass}`}
          >
            Delete
          </button>
        </SettingsRow>
      </SettingsCard>
    </>
  )
}
