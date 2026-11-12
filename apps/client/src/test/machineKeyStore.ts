import type { MachineKeyPin, MachineKeyStore } from '../lib/machineKeys'

/** A machine key pin store in memory, standing in for IndexedDB, which happy-dom doesn't have. */
export function memoryMachineKeyStore(initial: Record<string, MachineKeyPin> = {}) {
  const pins = new Map(Object.entries(initial))
  const store: MachineKeyStore = {
    get: async (machineId) => pins.get(machineId) ?? null,
    add: async (machineId, pin) => {
      if (pins.has(machineId)) throw new Error('ConstraintError')
      pins.set(machineId, pin)
    },
  }
  return { store, pins }
}
