/** The client's path for a machine's page. */
export function machinePath(id: string): string {
  return `/m/${encodeURIComponent(id)}`
}

/** Where older versions of the client kept the access keys from the connect links opened in this browser. */
const SAVED_KEYS = 'orch-machines'

/** The parts of `window` that `clearSavedMachineKeys` uses. */
export interface SavedKeysWindow {
  readonly localStorage: Pick<Storage, 'removeItem'>
  location: { hash: string; pathname: string; search: string }
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string): void }
}

/**
 * Removes the access keys an older client saved in this browser, and an old connect link's `key` from the address
 * bar, keeping the same path and search. A machine opens only through the signed-in account now, so a key here is a
 * credential any script on the origin could read, and nothing uses it. Storage that can't be reached is skipped.
 */
export function clearSavedMachineKeys(win: SavedKeysWindow = window): void {
  try {
    win.localStorage.removeItem(SAVED_KEYS)
  } catch {}
  if (!new URLSearchParams(win.location.hash.slice(1)).has('key')) return
  // Keep the router's state for this entry; only the URL changes.
  win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`)
}
