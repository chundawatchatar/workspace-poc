import { machineKeyMatches } from '@orch/shared'
import { withDeviceStore } from './deviceKey'

// The machine keys this browser pinned, one per machine id, kept in IndexedDB
// beside the device key and never in `localStorage`, a query key, a URL or a
// log. A pin comes from the machine itself (`routes.system.machineKey`), once
// the owner compared its fingerprint with the machine's own screen. Older
// clients also pinned the first key a connect link vouched for; those pins
// stay valid.

/** A pinned machine key: the raw Ed25519 public key, when it was pinned, and what vouched for its id. */
export interface MachineKeyPin {
  publicKey: string
  pinnedAt: string
  /**
   * `confirmed`: the owner compared the fingerprint, the only kind pinned now. `link`: pinned by an older client from
   * a connect link whose `fp` matched the id, still read as a valid pin.
   */
  source: 'link' | 'confirmed'
}

/**
 * Where this browser profile keeps its pins. `add` refuses when the machine already has one, so two tabs that pin at
 * once end up with the same pin. Tests pass an in-memory one.
 */
export interface MachineKeyStore {
  /** The pin for `machineId`; null means none yet. */
  get(machineId: string): Promise<MachineKeyPin | null>
  /** Saves `pin` for `machineId`. Rejects when one is already saved. */
  add(machineId: string, pin: MachineKeyPin): Promise<void>
}

const STORE = 'machine-keys'

function isPin(value: unknown): value is MachineKeyPin {
  const pin = value as MachineKeyPin
  return (
    typeof pin?.publicKey === 'string' &&
    typeof pin.pinnedAt === 'string' &&
    (pin.source === 'link' || pin.source === 'confirmed')
  )
}

/** The pins in IndexedDB (database `orch-device`, store `machine-keys`), keyed by machine id. */
export const indexedDbMachineKeyStore: MachineKeyStore = {
  get: async (machineId) => {
    const value: unknown = await withDeviceStore(STORE, 'readonly', (store) => store.get(machineId))
    return isPin(value) ? value : null
  },
  add: async (machineId, pin) => {
    const saved: unknown = await withDeviceStore(STORE, 'readonly', (store) => store.get(machineId))
    if (saved === undefined) {
      await withDeviceStore(STORE, 'readwrite', (store) => store.add(pin, machineId))
      return
    }
    if (isPin(saved)) throw new Error('This machine already has a pin')
    // A record this client can't read as a pin, such as one from a version that saved other fields, is no pin at
    // all, so it is replaced. Any two keys that hash to the same id are the same key, so a tab racing this one can only
    // save the same key.
    await withDeviceStore(STORE, 'readwrite', (store) => store.put(pin, machineId))
  },
}

/** The store the checks use when given none. Tests swap in an in-memory one, since happy-dom has no IndexedDB. */
export const machineKeyStores: { default: MachineKeyStore } = { default: indexedDbMachineKeyStore }

/**
 * How a served key stands: `pinned` matches the pin, `unpinned` hashes to the id but nothing is pinned yet, and
 * `mismatch` either doesn't hash to the id or differs from the pin.
 */
export type MachineKeyCheck = 'pinned' | 'unpinned' | 'mismatch'

/** Checks `publicKey`, as the machine served it, against `machineId` and this browser's pin for it. */
export async function checkMachineKey(
  machineId: string,
  publicKey: string,
  store: MachineKeyStore = machineKeyStores.default,
): Promise<MachineKeyCheck> {
  if (!(await machineKeyMatches(publicKey, machineId))) return 'mismatch'
  const pin = await store.get(machineId)
  if (!pin) return 'unpinned'
  return pin.publicKey === publicKey ? 'pinned' : 'mismatch'
}

/**
 * Pins `publicKey` for `machineId` as `confirmed`, once it hashes to the id. When another tab pinned first, its pin decides:
 * `pinned` when it holds the same key, else `mismatch`. Rejects when nothing could be saved.
 */
export async function pinMachineKey(
  machineId: string,
  publicKey: string,
  store: MachineKeyStore = machineKeyStores.default,
  now: Date = new Date(),
): Promise<'pinned' | 'mismatch'> {
  if (!(await machineKeyMatches(publicKey, machineId))) return 'mismatch'
  const added = await store.add(machineId, { publicKey, pinnedAt: now.toISOString(), source: 'confirmed' }).then(
    () => true,
    () => false,
  )
  if (added) return 'pinned'
  const pin = await store.get(machineId)
  if (!pin) throw new Error('The machine key could not be saved')
  return pin.publicKey === publicKey ? 'pinned' : 'mismatch'
}
