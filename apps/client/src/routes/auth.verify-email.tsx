import { FormError } from '@orch/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { linkClass } from '../components/Centered'
import { EmailLinkForm } from '../components/EmailLinkForm'
import { verifyEmailToken } from '../lib/auth'
import { takeEmailLinkToken, useEmailLinkArrivals } from '../lib/emailLink'

// No `leaveIfSignedIn`: an emailed link may be opened while signed in.
export const Route = createFileRoute('/auth/verify-email')({ component: VerifyEmailPage })

/** Where verifying the link's token has got to; `failed` carries the message to show. */
type Verification =
  | { state: 'none' }
  | { state: 'verifying' }
  | { state: 'verified' }
  | { state: 'failed'; message: string }

// A new link opened on this page starts it afresh.
function VerifyEmailPage() {
  return <VerifyEmail key={useEmailLinkArrivals()} />
}

function VerifyEmail() {
  // Taken once, on the first render, so the token is never read again from anywhere.
  const [token] = useState(() => takeEmailLinkToken('verify-email'))
  const [verification, setVerification] = useState<Verification>(token ? { state: 'verifying' } : { state: 'none' })
  const started = useRef(false)

  useEffect(() => {
    if (!token || started.current) return
    started.current = true
    void verifyEmailToken(token)
      .catch(() => 'Verifying the address failed. Try again.')
      .then((message) => setVerification(message ? { state: 'failed', message } : { state: 'verified' }))
  }, [token])

  const toSignIn = (
    <Link to="/auth/sign-in" className={linkClass}>
      Back to sign in
    </Link>
  )

  if (verification.state === 'verifying') {
    return (
      <AuthCard title="Verifying your email address">
        <p role="status" className="text-[13px] text-dim">
          One moment…
        </p>
      </AuthCard>
    )
  }
  if (verification.state === 'verified') {
    return (
      <AuthCard title="Email verified" focusTitle>
        <p role="status" className="text-[13px] text-dim">
          Your address is verified. You can sign in now.
        </p>
        <Link to="/auth/sign-in" className={`self-start ${linkClass}`}>
          Sign in
        </Link>
      </AuthCard>
    )
  }
  return (
    <ResendVerification problem={verification.state === 'failed' ? verification.message : null} footer={toSignIn} />
  )
}

/** The resend form, under `problem` when a link was refused. */
function ResendVerification({ problem, footer }: { problem: string | null; footer: ReactNode }) {
  const [sent, setSent] = useState<{ email: string; count: number } | null>(null)
  return (
    <AuthCard
      key={sent?.count ?? 0}
      title="Verify your email address"
      focusTitle={problem !== null || sent !== null}
      footer={footer}
    >
      {sent ? (
        <p role="status" className="text-[13px] text-dim">
          If <strong className="font-medium text-ink">{sent.email}</strong> has an account that still needs verifying,
          we sent it a new link.
        </p>
      ) : (
        <>
          <FormError message={problem} />
          <p className="text-[13px] text-dim">Enter your email address and we will send you a new verification link.</p>
        </>
      )}
      <EmailLinkForm
        kind="resend"
        submitLabel="Send a new link"
        onSent={(email) => setSent((last) => ({ email, count: (last?.count ?? 0) + 1 }))}
      />
    </AuthCard>
  )
}
