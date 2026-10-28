import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { helloFrame } from '@orch/shared'

/** Where the machine secret is kept. The server hashes it into the machine id, so it must never change. */
export function machineSecretFile(hostRoot: string) {
  return join(hostRoot, '.data', 'machine-secret')
}

/**
 * Reads the machine secret at `path`, creating it on first use: 32 random
 * bytes as unpadded base64url, readable only by this user. An existing file
 * is never overwritten, so a file that does not hold a valid secret throws.
 * Error messages never include the file's content.
 */
export function loadOrCreateMachineSecret(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    try {
      writeFileSync(path, randomSecret(), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // Another process created it first: read theirs instead.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const secret = readFileSync(path, 'utf8').trim()
  if (!helloFrame.shape.proof.safeParse(secret).success) {
    throw new Error(`the machine secret in ${path} is not valid. Restore it, or delete it to get a new machine id`)
  }
  return secret
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString('base64url')
}
