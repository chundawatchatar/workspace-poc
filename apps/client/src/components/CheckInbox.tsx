import { Button, FormError } from '@orch/ui'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { resendVerificationEmail } from '../lib/auth'
import { AuthCard } from './AuthCard'

/** How long the resend button stays off after it sent an email, so one click sends one email. */
export const RESEND_COOLDOWN_MS = 30_000

/**
 * The card shown once sign-up has sent the verification email to `email`, with a button that sends it again. The
 * address stays in this page's state, never in the URL.
 */
export function CheckInbox({ email, footer }: { email: string; footer: ReactNode }) {
  const [pending, setPending] = useState(false)
  const [coolingDown, setCoolingDown] = useState(false)
  const [resent, setResent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // A second click can land before React has disabled the button.
  const busy = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  async function resend() {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setProblem(null)
    const message = await resendVerificationEmail(email).catch(() => 'Sending the email failed. Try again.')
    setPending(false)
    if (message) {
      busy.current = false
      setProblem(message)
      return
    }
    setResent(true)
    setCoolingDown(true)
    timer.current = setTimeout(() => {
      busy.current = false
      setCoolingDown(false)
    }, RESEND_COOLDOWN_MS)
  }

  return (
    <AuthCard title="Check your inbox" focusTitle footer={footer}>
      <p role="status" className="text-[13px] text-dim">
        We sent a link to <strong className="font-medium text-ink">{email}</strong>. Open it to verify your address,
        then sign in.
      </p>
      <div className="flex flex-col gap-3">
        <FormError message={problem} />
        <Button variant="secondary" pending={pending} disabled={coolingDown} onClick={() => void resend()}>
          Send the link again
        </Button>
        {resent && (
          <p role="status" className="text-[13px] text-dim">
            We sent another link. It can take a minute to arrive, and you can ask again after 30 seconds.
          </p>
        )}
      </div>
    </AuthCard>
  )
}
