import { createPublicKey, verify } from 'node:crypto'
import { type helloFrame, helloSignedMessage, type ServerFrame } from '@orch/shared'
import type { z } from 'zod'

/**
 * True when `hello` carries a valid Ed25519 signature by its own `publicKey`
 * over `helloSignedMessage(nonce)`. A key that is not a valid Ed25519 point
 * counts as a bad signature.
 */
export function helloSignatureValid(hello: z.infer<typeof helloFrame>, nonce: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: hello.publicKey }, format: 'jwk' })
    return verify(null, helloSignedMessage(nonce), key, Buffer.from(hello.signature, 'base64url'))
  } catch {
    return false
  }
}

/** A machine's live tunnel, as later jobs see it. */
export interface MachineConnection {
  /** `machineIdFromPublicKey(publicKey)`, so the id names the key. */
  machineId: string
  /**
   * The machine's raw Ed25519 public key (unpadded base64url), which signed
   * this tunnel's `hello`. It is all the server keeps of the machine's
   * identity: the server never sees the private key.
   */
  publicKey: string
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
