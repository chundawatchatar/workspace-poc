import { type DeviceSigner, deviceKeyFingerprint, deviceSigner } from '@orch/terminal-ui'

/**
 * Where this browser profile keeps its one device key pair. `add` refuses when
 * a pair is already there, so two tabs that start at once end up with the
 * same key. Tests pass an in-memory one.
 */
export interface DeviceKeyStore {
  /** The saved pair; null means none yet. */
  get(): Promise<CryptoKeyPair | null>
  /** Saves `pair`. Rejects when one is already saved. */
  add(pair: CryptoKeyPair): Promise<void>
}

/** This browser's device key: what the transport signs with, and the fingerprint the user approves on the machine. */
export interface DeviceKey {
  signer: DeviceSigner
  fingerprint: string
}

const DATABASE = 'orch-device'
/** Version 1 had only `keys`; version 2 added `machine-keys`, the machine keys this browser pinned. */
const VERSION = 2
const STORE = 'keys'
/** Every store in the database: the device key pair, and the pinned machine keys (`machineKeys.ts`). */
export const DEVICE_DATABASE_STORES = [STORE, 'machine-keys'] as const
const KEY = 'device'

/** The parts of an `IDBDatabase` an upgrade touches. */
export interface UpgradingDatabase {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): unknown
}

/**
 * Creates whichever stores `db` is missing, so an upgrade from any earlier version keeps what is already there:
 * a profile's device key stays in `keys` when `machine-keys` is added.
 */
export function upgradeDeviceDatabase(db: UpgradingDatabase) {
  for (const name of DEVICE_DATABASE_STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Runs one request on `store` of the `orch-device` database, opening it (and upgrading it) for that request only. */
export async function withDeviceStore<T>(
  store: (typeof DEVICE_DATABASE_STORES)[number],
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const open = indexedDB.open(DATABASE, VERSION)
  open.onupgradeneeded = () => upgradeDeviceDatabase(open.result)
  const db = await settle(open)
  try {
    return await settle(use(db.transaction(store, mode).objectStore(store)))
  } finally {
    db.close()
  }
}

/**
 * The device key pair in IndexedDB (database `orch-device`). A `CryptoKey`
 * is stored as itself, so a non-extractable private key stays one.
 */
export const indexedDbKeyStore: DeviceKeyStore = {
  get: async () =>
    ((await withDeviceStore(STORE, 'readonly', (store) => store.get(KEY))) as CryptoKeyPair | undefined) ?? null,
  add: async (pair) => {
    await withDeviceStore(STORE, 'readwrite', (store) => store.add(pair, KEY))
  },
}

/** The store `loadDeviceKey` uses when given none. Tests swap in an in-memory one, since happy-dom has no IndexedDB. */
export const deviceKeyStores: { default: DeviceKeyStore } = { default: indexedDbKeyStore }

const loaded = new WeakMap<DeviceKeyStore, Promise<DeviceKey>>()

/**
 * This browser profile's device key, made the first time: an ECDSA P-256 pair
 * whose private key is generated with `extractable: false`, so no script can
 * export it, only ask the browser to sign with it. One load per store is shared.
 */
export function loadDeviceKey(store: DeviceKeyStore = deviceKeyStores.default): Promise<DeviceKey> {
  let key = loaded.get(store)
  if (!key) {
    key = load(store)
    // A failure isn't kept, so the next page that asks tries again.
    key.catch(() => loaded.delete(store))
    loaded.set(store, key)
  }
  return key
}

async function load(store: DeviceKeyStore): Promise<DeviceKey> {
  let pair = await store.get()
  if (!pair) {
    const fresh = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    // Another tab may have saved its own pair meanwhile; then that one is this profile's key.
    pair = await store.add(fresh).then(
      () => fresh,
      () => store.get(),
    )
    if (!pair) throw new Error('The device key could not be saved')
  }
  const signer = await deviceSigner(pair)
  return { signer, fingerprint: await deviceKeyFingerprint(signer.publicJwk) }
}
