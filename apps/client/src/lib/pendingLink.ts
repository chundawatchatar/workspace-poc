// A connect link waits here until it is linked to the signed-in account. It lives in `localStorage`, so the tab a
// verification email opens finds it too. It holds only the machine id and its default name, never the access key,
// which stays in `orch-machines`. Signing out or switching accounts clears it, and it expires after a day, so a later
// user of this browser never picks it up.

/** A machine waiting to be linked to the account once a user is signed in. */
export interface PendingMachineLink {
  machineId: string
  /** The name to link it with; the server keeps an existing name instead. */
  name: string
  /** When the connect link was opened, in milliseconds since the epoch. */
  savedAt: number
}

const KEY = 'orch-pending-machine-link'

/** How long a pending link waits for a sign-in before it is dropped. */
export const PENDING_LINK_MAX_AGE = 24 * 60 * 60 * 1000

function isPendingLink(value: unknown, now: number): value is PendingMachineLink {
  if (typeof value !== 'object' || value === null || 'key' in value) return false
  const link = value as PendingMachineLink
  if (typeof link.machineId !== 'string' || typeof link.name !== 'string' || typeof link.savedAt !== 'number') {
    return false
  }
  const age = now - link.savedAt
  return age >= 0 && age <= PENDING_LINK_MAX_AGE
}

/**
 * The machine waiting to be linked; null means none, or storage that can't be read. A corrupt entry, one holding a
 * `key`, and one older than a day read as none and are removed.
 */
export function readPendingMachineLink(now = Date.now()): PendingMachineLink | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {}
    if (isPendingLink(value, now)) return { machineId: value.machineId, name: value.name, savedAt: value.savedAt }
    localStorage.removeItem(KEY)
    return null
  } catch {
    return null
  }
}

/** Keeps a machine to link once a user is signed in, replacing any other waiting one. */
export function setPendingMachineLink(link: { machineId: string; name: string }, now = Date.now()) {
  try {
    const entry: PendingMachineLink = { machineId: link.machineId, name: link.name, savedAt: now }
    localStorage.setItem(KEY, JSON.stringify(entry))
  } catch {}
}

/**
 * Drops the waiting link. With `only`, it drops it only while that same link is still the one waiting, so a link
 * from a connect link opened during a send survives the send's answer.
 */
export function clearPendingMachineLink(only?: PendingMachineLink) {
  try {
    if (only) {
      const current = readPendingMachineLink()
      if (current && (current.machineId !== only.machineId || current.savedAt !== only.savedAt)) return
    }
    localStorage.removeItem(KEY)
  } catch {}
}
