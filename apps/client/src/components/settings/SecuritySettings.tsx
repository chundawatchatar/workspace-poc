import { Button, FormError } from '@orch/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import { signOutEverywhere } from '../../lib/accountSessions'
import { sessionQuery } from '../../lib/auth'
import { ChangePasswordForm } from '../account/ChangePasswordForm'
import { SessionsTable } from '../account/SessionsTable'
import { SettingsCard, SettingsRow, SettingsSection, SettingsTitle } from './SettingsSection'

/** The security settings page: change the password, and see and end the sessions the account is signed in with. */
export function SecuritySettings() {
  const user = useQuery(sessionQuery).data
  return (
    <>
      <SettingsTitle>Security</SettingsTitle>
      <SettingsSection title="Password">
        <PasswordCard />
      </SettingsSection>
      <SettingsSection title="Where you're signed in" action={<SignOutEverywhere />}>
        {user ? <SessionsTable userId={user.id} /> : null}
      </SettingsSection>
    </>
  )
}

/** A row like the other settings, whose button opens the change-password form inside the card. */
function PasswordCard() {
  const [open, setOpen] = useState(false)
  const formId = useId()
  return (
    <SettingsCard>
      <SettingsRow label="Password" description="Changing it signs you out on every other device.">
        <Button variant="secondary" aria-expanded={open} aria-controls={formId} onClick={() => setOpen(!open)}>
          {open ? 'Cancel' : 'Change password'}
        </Button>
      </SettingsRow>
      {open && (
        <div id={formId} className="py-4">
          <ChangePasswordForm />
        </div>
      )}
    </SettingsCard>
  )
}

/** Ends every session, this one included, after a second click to confirm. */
function SignOutEverywhere() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // True once the user has opened or cancelled the confirmation, so opening the page never moves focus.
  const toggled = useRef(false)

  // Confirm/Cancel replace the button that had focus, so focus follows the swap instead of falling to the page.
  // `Button`'s props have no `ref`, so the button is found by its `data-focus` mark.
  useEffect(() => {
    if (!toggled.current) return
    root.current?.querySelector<HTMLElement>(`[data-focus="${confirming ? 'confirm' : 'start'}"]`)?.focus()
  }, [confirming])

  const setConfirmingByUser = (value: boolean) => {
    toggled.current = true
    setConfirming(value)
  }
  const confirm = async () => {
    setPending(true)
    setFailed(false)
    try {
      await signOutEverywhere(queryClient)
      await navigate({ to: '/auth/sign-in' })
    } catch {
      setFailed(true)
      setPending(false)
    }
  }
  return (
    <div ref={root} className="flex shrink-0 flex-col items-end gap-2">
      {confirming ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-dim">Sign out on every device, this one included?</p>
          <Button data-focus="confirm" pending={pending} onClick={() => void confirm()}>
            Confirm
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => setConfirmingByUser(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button data-focus="start" variant="secondary" onClick={() => setConfirmingByUser(true)}>
          Sign out from all devices
        </Button>
      )}
      <FormError message={failed ? 'Signing out from all devices failed. Try again.' : null} />
    </div>
  )
}
