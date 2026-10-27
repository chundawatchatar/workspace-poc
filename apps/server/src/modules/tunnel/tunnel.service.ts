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

/** The live tunnel of each connected machine, by machine id. Lives in memory only. */
export class MachineRegistry {
  private readonly machines = new Map<string, MachineConnection>()

  /** Makes `conn` the machine's live tunnel. Returns the connection it replaced, which the caller closes. */
  register(conn: MachineConnection): MachineConnection | undefined {
    const previous = this.machines.get(conn.machineId)
    this.machines.set(conn.machineId, conn)
    return previous === conn ? undefined : previous
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
