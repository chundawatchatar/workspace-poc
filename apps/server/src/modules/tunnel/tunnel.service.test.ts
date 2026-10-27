import { describe, expect, test } from 'bun:test'
import { type MachineConnection, MachineRegistry, machineIdFromProof } from './tunnel.service'

const proofA = 'a'.repeat(43)
const proofB = 'b'.repeat(43)

function connection(machineId: string): MachineConnection {
  return { machineId, send: () => {}, close: () => {} }
}

describe('machineIdFromProof', () => {
  test('gives each proof a stable 43-character base64url id that does not contain it', () => {
    const id = machineIdFromProof(proofA)
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(machineIdFromProof(proofA)).toBe(id)
    expect(machineIdFromProof(proofB)).not.toBe(id)
    expect(id).not.toContain(proofA)
  })
})

describe('MachineRegistry', () => {
  test('keeps the newest connection per machine and ignores the removal of a replaced one', () => {
    const registry = new MachineRegistry()
    const old = connection('m1')
    const next = connection('m1')
    expect(registry.register(old)).toBeUndefined()
    expect(registry.register(next)).toBe(old)
    registry.remove(old)
    expect(registry.get('m1')).toBe(next)
    expect(registry.size).toBe(1)
    registry.remove(next)
    expect(registry.get('m1')).toBeUndefined()
    expect(registry.size).toBe(0)
  })
})
