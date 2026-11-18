import { z } from 'zod'
import { deviceFingerprint } from './deviceProof'
import { fromBase64url, machineIdFromPublicKey } from './tunnel'

// A browser checks a machine's key itself rather than taking the server's word
// for it. The machine id is the SHA-256 of the machine's Ed25519 public key, so
// a key the machine serves proves itself against the id, and the id is vouched
// for out of band, by the owner comparing `machineFingerprint` with the one the
// machine shows on its own screen.

/** A machine's raw Ed25519 public key, as unpadded base64url (43 characters). */
export const machinePublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const machineKeyResponse = z.object({ publicKey: machinePublicKey })
export type MachineKeyResponse = z.infer<typeof machineKeyResponse>

/**
 * The short form of a machine id that people compare: `deviceFingerprint` over
 * the first 10 bytes of the decoded id, which is the SHA-256 of the public key,
 * such as `ABCD-EFGH-JKMN-PQRS`. Throws for an id that isn't base64url.
 */
export function machineFingerprint(machineId: string): string {
  return deviceFingerprint(fromBase64url(machineId))
}

/**
 * True only when `publicKey` is a 43-character base64url key whose
 * `machineIdFromPublicKey` is `machineId`. WebCrypto only, so it runs in the
 * browser and on the host alike.
 */
export async function machineKeyMatches(publicKey: string, machineId: string): Promise<boolean> {
  if (!machinePublicKey.safeParse(publicKey).success) return false
  return (await machineIdFromPublicKey(publicKey)) === machineId
}
