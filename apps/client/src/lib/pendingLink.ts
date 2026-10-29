import type { ConnectTarget } from '@orch/shared'

// A connect link opened while signed out waits here until the user signs in. It lives in `sessionStorage`, so it
// ends with the tab, and an identity change clears it, so it never carries over to another account.

const KEY = 'orch-pending-machine-link'

/** The connect link waiting for a sign-in; null means none, or storage that can't be read. */
export function readPendingMachineLink(): ConnectTarget | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    const link = value as ConnectTarget | null
    return typeof link?.machineId === 'string' && typeof link.key === 'string' ? link : null
  } catch {
    return null
  }
}

/** Keeps a connect link until the user signs in. */
export function setPendingMachineLink(link: ConnectTarget) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ machineId: link.machineId, key: link.key }))
  } catch {}
}

/** Drops the waiting connect link, if any. */
export function clearPendingMachineLink() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {}
}
