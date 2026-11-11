import { describe, expect, test } from 'bun:test'
import { type MachineConnection, MachineRegistry } from './tunnel.service'

function connection(machineId: string): MachineConnection {
  return { machineId, publicKey: `${'P'.repeat(42)}w`, send: () => {}, close: () => {} }
}

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

  test('remote.off counts only from the live connection, and a new registration clears it', () => {
    const registry = new MachineRegistry()
    const old = connection('m1')
    const next = connection('m1')
    registry.register(old)
    registry.register(next)
    registry.markRemoteOff(old)
    expect(registry.isRemoteOff('m1')).toBe(false)

    registry.markRemoteOff(next)
    registry.remove(next)
    expect(registry.isRemoteOff('m1')).toBe(true)
    registry.register(connection('m1'))
    expect(registry.isRemoteOff('m1')).toBe(false)
  })
})
