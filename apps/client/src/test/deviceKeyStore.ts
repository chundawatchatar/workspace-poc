import type { DeviceKeyStore } from '../lib/deviceKey'

/**
 * A device key store in memory, standing in for IndexedDB, which happy-dom
 * doesn't have. `taken` is a pair another tab saved first.
 */
export function memoryKeyStore(taken: CryptoKeyPair | null = null) {
  let saved: CryptoKeyPair | null = null
  const store: DeviceKeyStore = {
    get: async () => saved,
    add: async (pair) => {
      if (taken) saved = taken
      if (saved) throw new Error('ConstraintError')
      saved = pair
    },
  }
  return { store, saved: () => saved }
}
