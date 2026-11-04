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
const STORE = 'keys'
const KEY = 'device'

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const open = indexedDB.open(DATABASE, 1)
  open.onupgradeneeded = () => open.result.createObjectStore(STORE)
  const db = await settle(open)
  try {
    return await settle(use(db.transaction(STORE, mode).objectStore(STORE)))
  } finally {
    db.close()
  }
}

/**
 * The device key pair in IndexedDB (database `orch-device`). A `CryptoKey`
 * is stored as itself, so a non-extractable private key stays one.
 */
export const indexedDbKeyStore: DeviceKeyStore = {
  get: async () => ((await withStore('readonly', (store) => store.get(KEY))) as CryptoKeyPair | undefined) ?? null,
  add: async (pair) => {
    await withStore('readwrite', (store) => store.add(pair, KEY))
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
