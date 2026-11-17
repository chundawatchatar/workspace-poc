import type { HostTransport } from '@orch/terminal-ui'
import { type ReactNode, useMemo, useState } from 'react'
import { KeyMismatch } from './MachineKeyCheck'

/** What the page's transport is built with on top of the machine's own options. */
export interface VerifiedTransportOptions {
  /** The machine key `MachineKeyCheck` checked and pinned. */
  machinePublicKey: string
  onMachineUnverified: () => void
}

export interface VerifiedMachineProps {
  /** The pinned key, from `MachineKeyCheck`. */
  publicKey: string
  /** Builds the page's transport, such as `createRemoteTransport` with relay tickets. */
  createTransport: (options: VerifiedTransportOptions) => HostTransport
  /** The machine's page, given the transport. */
  children: (transport: HostTransport) => ReactNode
}

/**
 * The machine's page on a transport that opens an end-to-end session with the pinned key before it sends anything.
 * When the machine's answer doesn't verify against that key, the page is swapped for the key mismatch warning, with
 * no Retry, so its terminals unmount and nothing reconnects.
 */
export function VerifiedMachine({ publicKey, createTransport, children }: VerifiedMachineProps) {
  const [unverified, setUnverified] = useState(false)
  const transport = useMemo(
    () => createTransport({ machinePublicKey: publicKey, onMachineUnverified: () => setUnverified(true) }),
    [createTransport, publicKey],
  )
  if (unverified) return <KeyMismatch />
  return children(transport)
}
