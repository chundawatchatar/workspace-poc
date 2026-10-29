import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { linkClass } from '../components/Centered'
import { EmailLinkForm } from '../components/EmailLinkForm'
import { leaveIfSignedIn } from '../lib/auth'

export const Route = createFileRoute('/auth/forgot-password')({
  // `leaveIfSignedIn` reads a `redirect` this page never has, so a signed-in visit goes home.
  beforeLoad: ({ context }) => leaveIfSignedIn({ context, search: {} }),
  component: ForgotPassword,
})

function ForgotPassword() {
  // The address the last link went to, and how many were sent: each send redraws the card and focuses its heading.
  const [sent, setSent] = useState<{ email: string; count: number } | null>(null)

  return (
    <AuthCard
      key={sent?.count ?? 0}
      title="Reset your password"
      focusTitle={sent !== null}
      footer={
        <Link to="/auth/sign-in" className={linkClass}>
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p role="status" className="text-[13px] text-dim">
          If an account exists for <strong className="font-medium text-ink">{sent.email}</strong>, we sent a link to
          reset its password.
        </p>
      ) : (
        <p className="text-[13px] text-dim">Enter your email address and we will send you a link to reset it.</p>
      )}
      <EmailLinkForm
        kind="forgot"
        submitLabel="Send the link"
        onSent={(email) => setSent((last) => ({ email, count: (last?.count ?? 0) + 1 }))}
      />
    </AuthCard>
  )
}
