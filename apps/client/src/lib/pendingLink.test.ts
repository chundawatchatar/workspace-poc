import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearPendingMachineLink,
  PENDING_LINK_MAX_AGE,
  readPendingMachineLink,
  setPendingMachineLink,
} from './pendingLink'
import { installMemoryStorage, uninstallMemoryStorage } from './testStorage'

const KEY = 'orch-pending-machine-link'

beforeEach(() => installMemoryStorage())
afterAll(() => uninstallMemoryStorage())

describe('the pending machine link', () => {
  test('keeps only the id, name and time, and lasts a day', () => {
    setPendingMachineLink({ machineId: 'm1', name: 'Machine m1', key: 'secret' } as never, 1_000)
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      machineId: 'm1',
      name: 'Machine m1',
      savedAt: 1_000,
    })
    expect(readPendingMachineLink(1_000 + PENDING_LINK_MAX_AGE)).toEqual({
      machineId: 'm1',
      name: 'Machine m1',
      savedAt: 1_000,
    })

    expect(readPendingMachineLink(1_001 + PENDING_LINK_MAX_AGE)).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  test('a corrupt entry, or one holding a key, reads as none and is removed', () => {
    const now = Date.now()
    for (const raw of [
      '{not json',
      '"m1"',
      JSON.stringify({ machineId: 'm1', savedAt: now }),
      JSON.stringify({ machineId: 'm1', name: 'Machine m1', savedAt: now, key: 'secret' }),
    ]) {
      localStorage.setItem(KEY, raw)
      expect(readPendingMachineLink(now)).toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    }
  })

  test('clearing a given link leaves a newer one waiting', () => {
    setPendingMachineLink({ machineId: 'm1', name: 'Machine m1' }, 1_000)
    const first = readPendingMachineLink(1_000)
    setPendingMachineLink({ machineId: 'm2', name: 'Machine m2' })
    if (first) clearPendingMachineLink(first)
    expect(readPendingMachineLink()?.machineId).toBe('m2')
    clearPendingMachineLink()
    expect(readPendingMachineLink()).toBeNull()
  })
})
