import { type ConnectRequest, type CreateEnrollmentResponse, formatTimeLeft, type ServerMachine } from '@orch/shared'
import { Button, Modal, showToast } from '@orch/ui'
import { Copy } from '@orch/ui/icons'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createEnrollment, requestsQuery } from '../../lib/accountMachines'
import { connectCommand } from '../../lib/connectCommand'
import { ConnectRequestRow } from './ConnectRequestRow'

/** What the dialog says when a key can't be created. */
const CREATE_FAILED = 'Creating a key failed. Try again.'

/** What the dialog says when the clipboard is missing or refuses. */
const COPY_FAILED = 'Copying failed. Select the text and copy it yourself.'

type Step =
  | { kind: 'creating' }
  | { kind: 'failed' }
  /** A key on screen. */
  | { kind: 'ready'; enrollment: CreateEnrollmentResponse; expiresAt: number }
  | { kind: 'linked'; machine: ServerMachine }
  | { kind: 'rejected'; request: ConnectRequest }

/**
 * Creates an enrollment key as it opens and shows it once, with what the user needs to connect a machine with it: the
 * `corch connect` command to run there, with the signed-in `email` and the server's tunnel address, and the key alone
 * for the machine's Remote access dialog, each with a Copy button, the key's last 4 characters and the time left. The
 * key lives only in this component's state, so it is gone once the dialog closes. While a key is on screen, it reads
 * the account's waiting connect requests every 2 seconds, and once a machine asks with this key (its request has the
 * key's `id`), it shows the machine's name and fingerprint with Accept and Reject, then what the answer did.
 */
export function ConnectMachineDialog({
  userId,
  email,
  onClose,
}: {
  userId: string
  email: string
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>({ kind: 'creating' })
  const [now, setNow] = useState(() => Date.now())
  const mounted = useRef(false)

  const create = useCallback(async () => {
    setStep({ kind: 'creating' })
    try {
      const enrollment = await createEnrollment()
      if (!mounted.current) return
      setNow(Date.now())
      setStep({ kind: 'ready', enrollment, expiresAt: Date.parse(enrollment.expiresAt) })
    } catch {
      if (!mounted.current) return
      showToast(CREATE_FAILED, 'error')
      setStep({ kind: 'failed' })
    }
  }, [])

  // The ref survives StrictMode's second effect run, so opening the dialog creates one key, not two.
  const started = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (!started.current) {
      started.current = true
      void create()
    }
    return () => {
      mounted.current = false
    }
  }, [create])

  const ready = step.kind === 'ready' ? step : null
  const expired = ready !== null && now >= ready.expiresAt

  useEffect(() => {
    if (!ready || expired) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ready, expired])

  const requests = useQuery({ ...requestsQuery(userId, { waiting: true }), enabled: ready !== null && !expired })
  const request = ready && requests.data?.requests.find((waiting) => waiting.id === ready.enrollment.id)

  return (
    <Modal title="Connect a machine" width="w-[520px] max-w-[94vw]" onClose={onClose}>
      {step.kind === 'creating' && (
        <p role="status" className="text-dim">
          Creating a key…
        </p>
      )}
      {step.kind === 'failed' && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-dim">No key was created.</p>
          <Button variant="secondary" onClick={() => void create()}>
            Retry
          </Button>
        </div>
      )}
      {ready && expired && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-dim">This key expired before a machine used it.</p>
          <Button onClick={() => void create()}>Create a new key</Button>
        </div>
      )}
      {ready && !expired && (
        <KeyDetails enrollment={ready.enrollment} email={email} msLeft={ready.expiresAt - now}>
          {request ? (
            <ConnectRequestRow
              request={request}
              userId={userId}
              onAccepted={(machine) => setStep({ kind: 'linked', machine })}
              onRejected={(rejected) => setStep({ kind: 'rejected', request: rejected })}
            />
          ) : (
            <p className="text-xs text-faint">Waiting for the machine to connect…</p>
          )}
        </KeyDetails>
      )}
      {step.kind === 'linked' && (
        <div className="flex flex-col items-start gap-3">
          <p role="status">{step.machine.name} is connected</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      )}
      {step.kind === 'rejected' && (
        <div className="flex flex-col items-start gap-3">
          <p role="status">{step.request.name} was not connected. Its key no longer works.</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      )}
    </Modal>
  )
}

/** The key and how to use it, then `children`: the machine waiting with this key, or a line saying none is yet. */
function KeyDetails({
  enrollment,
  email,
  msLeft,
  children,
}: {
  enrollment: CreateEnrollmentResponse
  email: string
  msLeft: number
  children: ReactNode
}) {
  const command = connectCommand({ email, key: enrollment.key, serverUrl: enrollment.serverUrl })
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="text-dim">
        Run this command on the machine you want to connect. Before it connects, it shows the server, your email and the
        key's last 4 characters, so you can check they match. Then it waits for you to accept it here. The key works
        once.
      </p>
      <CopyField label="Command" value={command} copyLabel="Copy command" />
      <CopyField label="Key, for the machine's Remote access dialog" value={enrollment.key} copyLabel="Copy key" />
      <div className="flex items-center justify-between gap-3 text-dim">
        <span>
          Key ends in <span className="font-mono text-ink">{enrollment.fingerprint}</span>
        </span>
        <span>
          Expires in <span className="font-mono text-ink">{formatTimeLeft(msLeft)}</span>
        </span>
      </div>
      {children}
    </div>
  )
}

function CopyField({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  async function copy() {
    try {
      // Missing on an insecure origin, so a missing clipboard lands in the catch too.
      await navigator.clipboard.writeText(value)
      showToast('Copied')
    } catch {
      showToast(COPY_FAILED, 'error')
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-dim">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono">
          {value}
        </code>
        <Button variant="secondary" aria-label={copyLabel} onClick={() => void copy()}>
          <Copy size={14} aria-hidden />
          Copy
        </Button>
      </div>
    </div>
  )
}
