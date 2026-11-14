import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where the machine key is kept. The machine id is the hash of its public key, so it must never change. */
export function machineKeyFile(dataDir: string) {
  return join(dataDir, 'machine-key')
}

/**
 * The machine's Ed25519 key, as the rest of the host sees it. The private key
 * stays inside `sign`, so nothing can print, send or save it.
 */
export interface MachineKey {
  /** The raw 32-byte public key, as unpadded base64url. */
  readonly publicKey: string
  /** The id the server gives this machine: `machineIdFromPublicKey(publicKey)`, computed once at load. */
  readonly machineId: string
  /** Signs `message` with the private key, answering the 64-byte signature as unpadded base64url. */
  sign(message: Uint8Array): string
}

/**
 * Reads the machine key at `path`, creating it on first use: an Ed25519
 * private key as PKCS#8 PEM, readable only by this user. An existing file is
 * never overwritten, so a file that does not hold a valid key throws. Error
 * messages never include the file's content.
 */
export function loadOrCreateMachineKey(path: string): MachineKey {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    const { privateKey } = generateKeyPairSync('ed25519')
    try {
      writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // Another process created it first: read theirs instead.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const privateKey = parsePrivateKey(readFileSync(path, 'utf8'))
  if (!privateKey) {
    throw new Error(`the machine key in ${path} is not valid. Restore it, or delete it to get a new machine id`)
  }
  const raw = createPublicKey(privateKey).export({ format: 'jwk' }).x
  if (!raw) throw new Error(`the machine key in ${path} has no public key`)
  const publicKey = raw.replace(/=+$/, '')
  return {
    publicKey,
    machineId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url'),
    sign: (message) => sign(null, message, privateKey).toString('base64url'),
  }
}

/** The Ed25519 private key in `pem`, or null for anything else. Never quotes the input. */
function parsePrivateKey(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch {
    return null
  }
}
