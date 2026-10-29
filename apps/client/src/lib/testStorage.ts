type StorageName = 'localStorage' | 'sessionStorage'

const originals = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage }

/** Installs an in-memory `localStorage` (or `sessionStorage`), which Bun's test runner doesn't provide. */
export function installMemoryStorage(name: StorageName = 'localStorage'): Storage {
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
  globalThis[name] = storage
  return storage
}

/** Puts back whatever `localStorage` (or `sessionStorage`) was before `installMemoryStorage`. */
export function uninstallMemoryStorage(name: StorageName = 'localStorage') {
  globalThis[name] = originals[name]
}
