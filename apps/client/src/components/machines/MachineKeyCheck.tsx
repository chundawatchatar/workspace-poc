import { DEVICE_NOT_APPROVED_CODE, fingerprintKey, machineFingerprint, routes } from '@orch/shared'
import { callApi, HostApiError, type HostTransport } from '@orch/terminal-ui'
import { Button, TextField } from '@orch/ui'
import { ShieldAlert } from '@orch/ui/icons'
import { Link } from '@tanstack/react-router'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'
import { checkMachineKey, type MachineKeyStore, machineKeyStores, pinMachineKey } from '../../lib/machineKeys'
import { Centered, linkClass } from '../Centered'

/** How long the page waits before asking the machine again while this browser waits for approval there. */
const UNAPPROVED_RETRY_MS = 3000

export interface MachineKeyCheckProps {
  machineId: string
  /** The transport `<TerminalUI>` gets, so the key comes from the machine the same way its terminals will. */
  transport: HostTransport
  /**
   * What vouched for the id: `link`, a connect link whose `fp` matched it, so the first key is pinned without asking;
   * `account`, the server's list only, so the owner compares the fingerprint first.
   */
  vouchedBy: 'link' | 'account'
  /** Shown while the machine answers that this browser isn't approved there. */
  unapprovedHint: ReactNode
  /** Shown after a 401, when the key or the account was refused. */
  deniedHint: ReactNode
  /** Where pins are kept. Defaults to `machineKeyStores.default`. */
  store?: MachineKeyStore
  retryMs?: number
  /** The machine's page, mounted only once its key is checked, given that key as this browser pinned it. */
  children: (publicKey: string) => ReactNode
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'unapproved' }
  | { kind: 'failed'; denied: boolean }
  | { kind: 'confirm'; publicKey: string }
  | { kind: 'mismatch' }
  | { kind: 'open'; publicKey: string }

/** What the page does next, once the machine answered its key, or failed to. */
async function checkKey({
  machineId,
  transport,
  vouchedBy,
  store,
  signal,
}: Pick<MachineKeyCheckProps, 'machineId' | 'transport' | 'vouchedBy'> & {
  store: MachineKeyStore
  signal: AbortSignal
}): Promise<Phase> {
  let publicKey: string
  try {
    ;({ publicKey } = await callApi(routes.system.machineKey, {}, signal, transport))
  } catch (error) {
    // An answer that isn't a key at all is no more the machine's key than a wrong one.
    if (error instanceof ZodError) return { kind: 'mismatch' }
    const refused = error instanceof HostApiError ? error : null
    if (refused?.status === 403 && refused.code === DEVICE_NOT_APPROVED_CODE) return { kind: 'unapproved' }
    return { kind: 'failed', denied: refused?.status === 401 }
  }
  const result = await checkMachineKey(machineId, publicKey, store)
  if (result === 'pinned') return { kind: 'open', publicKey }
  if (result === 'mismatch') return { kind: 'mismatch' }
  if (vouchedBy === 'account') return { kind: 'confirm', publicKey }
  const pinned = await pinMachineKey(machineId, publicKey, 'link', store)
  return pinned === 'pinned' ? { kind: 'open', publicKey } : { kind: 'mismatch' }
}

/**
 * Checks the machine's key before its page mounts. It fetches `routes.system.machineKey` through `transport` and
 * checks the key hashes to `machineId` and equals this browser's pin. With no pin yet, a link's key is pinned at
 * once and an account's waits for the owner to confirm the fingerprint. A key that fails either check stops here
 * with a warning and no Retry, so no terminal socket opens and nothing reconnects. The page gets the checked key, so
 * its own transport can make the machine prove it holds that key.
 */
export function MachineKeyCheck({
  machineId,
  transport,
  vouchedBy,
  unapprovedHint,
  deniedHint,
  store = machineKeyStores.default,
  retryMs = UNAPPROVED_RETRY_MS,
  children,
}: MachineKeyCheckProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how Retry and the approval wait ask again.
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (next: Phase) => {
      if (controller.signal.aborted) return
      setPhase(next)
      if (next.kind === 'unapproved') timer = setTimeout(() => setAttempt((n) => n + 1), retryMs)
    }
    checkKey({ machineId, transport, vouchedBy, store, signal: controller.signal }).then(settle, () =>
      settle({ kind: 'failed', denied: false }),
    )
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [attempt, machineId, transport, vouchedBy, store, retryMs])

  const retry = () => {
    setPhase({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  switch (phase.kind) {
    case 'open':
      return children(phase.publicKey)
    case 'mismatch':
      return <KeyMismatch />
    case 'confirm':
      return (
        <ConfirmFingerprint
          machineId={machineId}
          onConfirm={async () => {
            const pinned = await pinMachineKey(machineId, phase.publicKey, 'confirmed', store)
            setPhase(pinned === 'pinned' ? { kind: 'open', publicKey: phase.publicKey } : { kind: 'mismatch' })
          }}
          onReject={() => setPhase({ kind: 'mismatch' })}
          onFailed={() => setPhase({ kind: 'failed', denied: false })}
        />
      )
    case 'unapproved':
      return (
        <Centered>
          <p role="status">This browser is not approved on the machine yet.</p>
          <p className="max-w-md text-center text-xs">{unapprovedHint}</p>
        </Centered>
      )
    case 'failed':
      return (
        <Centered>
          <p role="alert">
            {phase.denied ? 'The machine refused this browser.' : "The machine's key could not be read."}
          </p>
          {phase.denied && <p className="max-w-md text-center text-xs">{deniedHint}</p>}
          <Button variant="secondary" onClick={retry}>
            Retry
          </Button>
        </Centered>
      )
    case 'loading':
      return (
        <Centered>
          <p role="status">Checking the machine's key…</p>
        </Centered>
      )
  }
}

const command = (text: string) => <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-ink">{text}</code>

/**
 * Asks the owner to type the fingerprint the machine shows locally. The page never shows its own, so the owner can't
 * copy it from here instead of reading the machine, and Confirm is enabled only once the typed one matches, so a stray
 * click can't pin a key. "It doesn't match" pins nothing.
 */
function ConfirmFingerprint({
  machineId,
  onConfirm,
  onReject,
  onFailed,
}: {
  machineId: string
  onConfirm: () => Promise<void>
  onReject: () => void
  onFailed: () => void
}) {
  const fingerprint = machineFingerprint(machineId)
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  const matches = fingerprintKey(typed) === fingerprintKey(fingerprint)
  const complete = fingerprintKey(typed).length >= fingerprintKey(fingerprint).length
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!matches || pending) return
    setPending(true)
    onConfirm().catch(onFailed)
  }
  return (
    <Centered>
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3 text-[13px]">
        <h1 className="text-base font-medium text-ink">Check this machine's key</h1>
        <p>
          This is the first time this browser opens the machine through your account. On the machine, find Machine key
          in its Remote access setting, or run {command('bun run host:remote status')}, and type the fingerprint it
          shows.
        </p>
        <TextField
          ref={field}
          label="Machine key fingerprint"
          name="machine-fingerprint"
          autoComplete="off"
          value={typed}
          onChange={setTyped}
          error={
            complete && !matches
              ? "That isn't this machine's key. Check what you typed; if it's what the machine shows, it doesn't match."
              : null
          }
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={!matches} pending={pending}>
            Confirm
          </Button>
          <Button variant="secondary" disabled={pending} onClick={onReject}>
            It doesn't match
          </Button>
        </div>
      </form>
    </Centered>
  )
}

/** The stop for a key that isn't the machine's: no Retry, since opening it anyway is what an impostor wants. */
export function KeyMismatch() {
  return (
    <Centered>
      <ShieldAlert size={20} className="text-bad" />
      <p role="alert" className="font-medium text-ink">
        The machine key doesn't match.
      </p>
      <p className="max-w-md text-center text-xs">
        The key this page got isn't the one this browser trusts for the machine, so something between them may be posing
        as it. The page stopped and won't connect. Check the machine's fingerprint with{' '}
        {command('bun run host:remote status')} on it, and don't open it here until you know why.
      </p>
      <Link to="/" className={`text-xs ${linkClass}`}>
        Back to your machines
      </Link>
    </Centered>
  )
}
