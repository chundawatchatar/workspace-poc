import type { CreateEnrollmentResponse, ServerMachine } from '@orch/shared'
import { Button, Modal, showToast } from '@orch/ui'
import { Copy } from '@orch/ui/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createEnrollment, machinesQuery, newMachine } from '../../lib/accountMachines'

/** What the dialog says when a key can't be created. */
const CREATE_FAILED = 'Creating a key failed. Try again.'

/** What the dialog says when the clipboard is missing or refuses. */
const COPY_FAILED = 'Copying failed. Select the text and copy it yourself.'

/** The command a machine runs to link itself with `key`. */
function linkCommand(key: string) {
  return `bun run host:remote link ${key}`
}

/** The time left until `expiresAt`, as `mm:ss`, rounded up to the second and never below `00:00`. */
function formatCountdown(msLeft: number) {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

type Step =
  | { kind: 'creating' }
  | { kind: 'failed' }
  /** A key on screen, with the machine ids listed when it was created. */
  | { kind: 'ready'; enrollment: CreateEnrollmentResponse; expiresAt: number; baseline: string[] }
  | { kind: 'linked'; machine: ServerMachine }

/**
 * Creates an enrollment key as it opens and shows it once, with what the user needs to link a machine with it: the
 * key and the command to run there, each with a Copy button, its fingerprint and the time left. The key lives only in
 * this component's state, so it is gone once the dialog closes. While open, it reads the account's machines every 2
 * seconds and says so when a new one appears.
 */
export function ConnectMachineDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>({ kind: 'creating' })
  const [now, setNow] = useState(() => Date.now())
  const list = useQuery(machinesQuery(userId, { linking: true }))
  const mounted = useRef(false)

  const create = useCallback(async () => {
    setStep({ kind: 'creating' })
    try {
      const enrollment = await createEnrollment()
      const listed = await queryClient.ensureQueryData(machinesQuery(userId))
      if (!mounted.current) return
      setNow(Date.now())
      setStep({
        kind: 'ready',
        enrollment,
        expiresAt: Date.parse(enrollment.expiresAt),
        baseline: listed.machines.map((m) => m.machineId),
      })
    } catch {
      if (!mounted.current) return
      showToast(CREATE_FAILED, 'error')
      setStep({ kind: 'failed' })
    }
  }, [queryClient, userId])

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

  const linked = ready && list.data ? newMachine(ready.baseline, list.data.machines) : undefined
  useEffect(() => {
    if (linked) setStep({ kind: 'linked', machine: linked })
  }, [linked])

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
      {ready && !expired && <KeyDetails enrollment={ready.enrollment} msLeft={ready.expiresAt - now} />}
      {step.kind === 'linked' && (
        <div className="flex flex-col items-start gap-3">
          <p role="status">{step.machine.name} is linked</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      )}
    </Modal>
  )
}

function KeyDetails({ enrollment, msLeft }: { enrollment: CreateEnrollmentResponse; msLeft: number }) {
  const command = linkCommand(enrollment.key)
  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <p className="text-dim">
        Run this command on the machine you want to connect. The key works once, and the machine shows its fingerprint
        so you can check it is this one.
      </p>
      <CopyField label="Command" value={command} copyLabel="Copy command" />
      <CopyField label="Key" value={enrollment.key} copyLabel="Copy key" />
      <div className="flex items-center justify-between gap-3 text-dim">
        <span>
          Fingerprint <span className="font-mono text-ink">{enrollment.fingerprint}</span>
        </span>
        <span>
          Expires in <span className="font-mono text-ink">{formatCountdown(msLeft)}</span>
        </span>
      </div>
      <p className="text-xs text-faint">Waiting for the machine to link…</p>
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
