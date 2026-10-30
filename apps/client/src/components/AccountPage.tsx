import { Button, FormError } from '@orch/ui'
import { ArrowLeft } from '@orch/ui/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { signOutEverywhere } from '../lib/accountSessions'
import { sessionQuery } from '../lib/auth'
import { AccountMenu } from './AccountMenu'
import { linkClass } from './Centered'
import { ChangePasswordForm } from './ChangePasswordForm'
import { SessionsTable } from './SessionsTable'

/** The account page: change the password, and see and end the sessions the account is signed in with. */
export function AccountPage() {
  const user = useQuery(sessionQuery).data
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto p-8">
      <div className="flex flex-col gap-3">
        <Link to="/" className={`flex items-center gap-1.5 self-start text-xs ${linkClass}`}>
          <ArrowLeft size={13} />
          Your machines
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="flex-1 text-base font-semibold text-ink">Account</h1>
          <AccountMenu className="min-w-0" />
        </div>
        {user && (
          <p className="text-dim">
            Signed in as <span className="text-ink">{user.name}</span> ({user.email})
          </p>
        )}
      </div>
      <Section title="Change password">
        <ChangePasswordForm />
      </Section>
      <Section title="Devices">
        {user ? <SessionsTable userId={user.id} /> : null}
        <SignOutEverywhere />
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {children}
    </section>
  )
}

/** Ends every session, this one included, after a second click to confirm. */
function SignOutEverywhere() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
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
    <div className="flex flex-col items-start gap-2">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-dim">Sign out on every device, this one included?</p>
          <Button pending={pending} onClick={() => void confirm()}>
            Confirm
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Sign out from all devices
        </Button>
      )}
      <FormError message={failed ? 'Signing out from all devices failed. Try again.' : null} />
    </div>
  )
}
