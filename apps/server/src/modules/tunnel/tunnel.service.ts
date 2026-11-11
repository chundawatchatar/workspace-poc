import type { ServerFrame } from '@orch/shared'

/**
 * Derives a machine's id from the secret in its `hello`: the SHA-256 of the
 * proof's UTF-8 bytes as unpadded base64url (43 characters). The id is stable
 * for a machine and reveals nothing about the secret.
 */
export function machineIdFromProof(proof: string): string {
  return new Bun.CryptoHasher('sha256').update(proof).digest('base64url').replace(/=+$/, '')
}

/** A machine's live tunnel, as later jobs see it. */
export interface MachineConnection {
  machineId: string
  send(frame: ServerFrame): void
  close(code: number, reason: string): void
}

/**
 * The live tunnel of each connected machine, by machine id, and the machines
 * whose owner last turned remote access off. Lives in memory only, so a
 * restart forgets both.
 */
export class MachineRegistry {
  private readonly machines = new Map<string, MachineConnection>()
  private readonly remoteOff = new Set<string>()

  /**
   * Makes `conn` the machine's live tunnel, which clears its remote-off mark.
   * Returns the connection it replaced, which the caller closes.
   */
  register(conn: MachineConnection): MachineConnection | undefined {
    const previous = this.machines.get(conn.machineId)
    this.machines.set(conn.machineId, conn)
    this.remoteOff.delete(conn.machineId)
    return previous === conn ? undefined : previous
  }

  /** Marks the machine's remote access as off, from its `remote.off`, only while `conn` is still its live tunnel. */
  markRemoteOff(conn: MachineConnection): void {
    if (this.machines.get(conn.machineId) === conn) this.remoteOff.add(conn.machineId)
  }

  /** True when the machine's last live tunnel sent `remote.off`. A new `hello` clears it. */
  isRemoteOff(machineId: string): boolean {
    return this.remoteOff.has(machineId)
  }

  /** Forgets `conn`. A connection that was already replaced leaves its successor in place. */
  remove(conn: MachineConnection): void {
    if (this.machines.get(conn.machineId) === conn) this.machines.delete(conn.machineId)
  }

  get(machineId: string): MachineConnection | undefined {
    return this.machines.get(machineId)
  }

  /** The number of connected machines. */
  get size(): number {
    return this.machines.size
  }
}
