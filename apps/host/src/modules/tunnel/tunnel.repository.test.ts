import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helloFrame } from '@orch/shared'
import { loadOrCreateMachineSecret, machineSecretFile } from './tunnel.repository'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tunnel-secret-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('loadOrCreateMachineSecret', () => {
  test('creates a private secret once and returns the same one afterwards', () => {
    const file = machineSecretFile(root)
    const secret = loadOrCreateMachineSecret(file)
    expect(secret).toHaveLength(43)
    expect(helloFrame.shape.proof.safeParse(secret).success).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(loadOrCreateMachineSecret(file)).toBe(secret)
    expect(readFileSync(file, 'utf8')).toBe(secret)
  })

  test('refuses an invalid file without overwriting it or quoting it', () => {
    const file = join(root, 'machine-secret')
    writeFileSync(file, 'not-a-secret-but-private')
    expect(() => loadOrCreateMachineSecret(file)).toThrow(/not valid/)
    try {
      loadOrCreateMachineSecret(file)
    } catch (error) {
      expect(String(error)).not.toContain('not-a-secret-but-private')
    }
    expect(readFileSync(file, 'utf8')).toBe('not-a-secret-but-private')
  })
})
