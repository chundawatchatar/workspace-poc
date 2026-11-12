import {
  type ConnectTarget,
  fingerprintKey,
  machineFingerprint,
  machineIdSchema,
  parseConnectFragment,
} from '@orch/shared'
import { useSyncExternalStore } from 'react'

// The access keys this browser holds, from the connect links opened in it, kept in
// `localStorage`. Any script on this origin can read them. The account's machine
// list comes from the server; this only says which of them this browser can open.

/** A machine whose access key this browser holds. */
export interface SavedMachine {
  id: string
  name: string
  /** The access key from the connect link. */
  key: string
  /** `machineFingerprint(id)`, which the connect link's `fp` matched. */
  fingerprint: string
}

const KEY = 'orch-machines'
const listeners = new Set<() => void>()

function isSavedMachine(value: unknown): value is SavedMachine {
  const m = value as SavedMachine
  return (
    typeof m?.id === 'string' &&
    typeof m.name === 'string' &&
    typeof m.key === 'string' &&
    typeof m.fingerprint === 'string' &&
    m.id !== ''
  )
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function parse(raw: string | null): SavedMachine[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(value) ? value.filter(isSavedMachine) : []
  } catch {
    return []
  }
}

function write(machines: SavedMachine[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(machines))
  } catch {}
  for (const listener of listeners) listener()
}

/** The saved machines, in the order they were first linked. Corrupt or missing data reads as none. */
export function loadMachines(): SavedMachine[] {
  return parse(readRaw())
}

/** Saves a machine, replacing a saved one with the same id in place. */
export function saveMachine(machine: SavedMachine) {
  const machines = loadMachines()
  const known = machines.some((m) => m.id === machine.id)
  write(known ? machines.map((m) => (m.id === machine.id ? machine : m)) : [...machines, machine])
}

/** Removes a machine and its key from this browser. */
export function forgetMachine(id: string) {
  write(loadMachines().filter((m) => m.id !== id))
}

/** The name a machine gets when it is linked. */
export function defaultMachineName(id: string): string {
  return `Machine ${id.slice(0, 8)}`
}

/** The client's path for a machine's page. */
export function machinePath(id: string): string {
  return `/m/${encodeURIComponent(id)}`
}

/** The parts of `window` that `acceptConnectLink` uses. */
export interface ConnectWindow {
  location: { hash: string; pathname: string; search: string }
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string): void }
}

/**
 * True when the link's `fp` is the fingerprint of its machine id, which must be a real one. The host printed the
 * link, so a match vouches for the id without the server.
 */
function fingerprintMatches({ machineId, fingerprint }: ConnectTarget): boolean {
  if (!machineIdSchema.safeParse(machineId).success) return false
  return fingerprintKey(fingerprint) === fingerprintKey(machineFingerprint(machineId))
}

/**
 * Saves the machine from a connect link's fragment (`#machine=<id>&key=<key>&fp=<fingerprint>`) in this browser and
 * replaces the URL with the machine's page, so the key leaves the address bar and history. It sends nothing to the
 * account: a machine joins the account's list only by redeeming an enrollment key. Returns the machine id, or null
 * when the fragment isn't a complete connect link or its `fp` isn't its machine's fingerprint. Such a link that still
 * carries a `key` is removed from the URL, unsaved.
 */
export function acceptConnectLink(win: ConnectWindow = window): string | null {
  const target = parseConnectFragment(win.location.hash)
  if (!target || !fingerprintMatches(target)) {
    if (new URLSearchParams(win.location.hash.slice(1)).has('key')) {
      // Keep the router's state for this entry; only the URL changes.
      win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`)
    }
    return null
  }
  const { machineId, key } = target
  saveMachine({ id: machineId, name: defaultMachineName(machineId), key, fingerprint: machineFingerprint(machineId) })
  win.history.replaceState(null, '', machinePath(target.machineId))
  return target.machineId
}

let cache: { raw: string | null; machines: SavedMachine[] } = { raw: null, machines: [] }

function snapshot(): SavedMachine[] {
  const raw = readRaw()
  if (raw !== cache.raw) cache = { raw, machines: parse(raw) }
  return cache.machines
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // Another tab linking or forgetting a machine shows up here too.
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

/** The saved machines, kept up to date as they change in this tab or another. */
export function useMachines(): SavedMachine[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
