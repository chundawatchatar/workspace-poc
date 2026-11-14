import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helloFrame, machineIdFromPublicKey } from '@orch/shared'
import { loadOrCreateMachineKey, machineKeyFile } from './tunnel.repository'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tunnel-key-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('loadOrCreateMachineKey', () => {
  test('creates a private key file once, then loads the same key and id without rewriting it', async () => {
    const file = machineKeyFile(root)
    expect(file).toBe(join(root, 'machine-key'))
    const key = loadOrCreateMachineKey(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const content = readFileSync(file, 'utf8')
    const { mtimeMs } = statSync(file)

    expect(helloFrame.shape.publicKey.safeParse(key.publicKey).success).toBe(true)
    expect(key.machineId).toBe(await machineIdFromPublicKey(key.publicKey))

    const again = loadOrCreateMachineKey(file)
    expect(again.publicKey).toBe(key.publicKey)
    expect(again.machineId).toBe(key.machineId)
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(statSync(file).mtimeMs).toBe(mtimeMs)

    // The file holds the private key for `publicKey`, and `sign` signs with it.
    const publicKey = createPublicKey(createPrivateKey(content))
    expect(publicKey.export({ format: 'jwk' }).x).toBe(key.publicKey)
    const message = new TextEncoder().encode('hello')
    expect(verify(null, message, publicKey, Buffer.from(key.sign(message), 'base64url'))).toBe(true)
  })

  test('refuses an invalid file without overwriting it or quoting it', () => {
    const file = join(root, 'machine-key')
    for (const content of ['not-a-key-but-private', `${'A'.repeat(42)}w`]) {
      writeFileSync(file, content)
      expect(() => loadOrCreateMachineKey(file)).toThrow(/not valid/)
      expect(() => loadOrCreateMachineKey(file)).not.toThrow(content)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
})
