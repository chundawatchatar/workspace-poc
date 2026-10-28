const original = globalThis.localStorage

/** Installs an in-memory `localStorage`, which Bun's test runner doesn't provide. */
export function installMemoryStorage(): Storage {
  const items = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
  globalThis.localStorage = storage
  return storage
}

/** Puts back whatever `localStorage` was before `installMemoryStorage`. */
export function uninstallMemoryStorage() {
  globalThis.localStorage = original
}
