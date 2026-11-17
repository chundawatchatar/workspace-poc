import { type ApprovedDevice, type DevicesResponse, fingerprintKey, type PendingDevice, routes } from '@orch/shared'
import { fingerprintOf } from './modules/remote-access/device-proof.service'
import { DevicesRepository, devicesPath, type SavedDevice } from './modules/remote-access/devices.repository'
import type { RemoteCliDeps } from './remote-cli'
import { messageOf, printable, refused } from './remote-cli-output'

// `bun run host:remote devices ...`: the Devices list of the Remote access
// setting. `approve` sends the typed fingerprint, and the host matches it
// against its waiting devices. `remove` takes a device id, so it resolves the
// typed fingerprint from a fresh list. Nothing here prints an id or a key.

export type DevicesCommand =
  | { name: 'devices' }
  | { name: 'approve'; fingerprint: string; yes: boolean }
  | { name: 'remove'; fingerprint: string }

/** The command the words after `devices` name, or null when they don't make one. */
export function parseDevicesArgs(rest: string[]): DevicesCommand | null {
  const [action, ...more] = rest
  if (action === undefined) return { name: 'devices' }
  if (action === 'approve') {
    const fingerprints = more.filter((arg) => arg !== '--yes')
    const [fingerprint] = fingerprints
    return fingerprints.length === 1 && fingerprint
      ? { name: 'approve', fingerprint, yes: more.includes('--yes') }
      : null
  }
  if (action === 'remove') return more.length === 1 && more[0] ? { name: 'remove', fingerprint: more[0] } : null
  return null
}

/** Runs a `devices` command against the running host. */
export async function devicesThroughHost(command: DevicesCommand, deps: RemoteCliDeps): Promise<number> {
  const devices = await deps.callHost(routes.remoteAccess.devices, {})
  if (!devices?.ok) return refused(devices, deps.err)
  if (command.name === 'devices') {
    printDevices(devices.data, deps)
    return 0
  }
  if (command.name === 'approve') return approve(devices.data, command.fingerprint, command.yes, deps)
  const found = findDevice(devices.data, command.fingerprint, deps)
  if (!found) return 1
  return remove(found, deps)
}

/**
 * Asks unless `--yes` was given, then sends the typed fingerprint for the host
 * to approve the one waiting device it matches. A device the list already shows
 * approved is reported as such without asking.
 */
async function approve(devices: DevicesResponse, typed: string, yes: boolean, deps: RemoteCliDeps): Promise<number> {
  const wanted = fingerprintKey(typed)
  const fingerprint = printable(typed.trim())
  const known = devices.approved.find((device) => fingerprintKey(device.fingerprint) === wanted)
  if (known) {
    deps.out(`${printable(known.fingerprint)} is already approved`)
    return 0
  }
  if (!yes) {
    deps.out('Approve only a fingerprint shown in your own browser.')
    const answer = await deps.prompt(`Approve ${fingerprint}? It will be able to open this machine remotely. [y/N] `)
    if (answer === null) {
      deps.err(
        'No answer could be read, so nothing was approved. Run this in a terminal, or add --yes once the fingerprint matches the one your browser shows.',
      )
      return 1
    }
    if (!/^(y|yes)$/i.test(answer.trim())) {
      deps.err('Not approved')
      return 1
    }
  }
  const approved = await deps.callHost(routes.remoteAccess.approveDevice, { fingerprint: typed.trim() })
  if (!approved?.ok) return refused(approved, deps.err)
  const shown = approved.data.approved.find((device) => fingerprintKey(device.fingerprint) === wanted)?.fingerprint
  deps.out(`Approved ${shown ? printable(shown) : fingerprint}. It can open this machine remotely now.`)
  return 0
}

/** Dismisses the waiting device, or revokes the approved one. */
async function remove(found: FoundDevice, deps: RemoteCliDeps): Promise<number> {
  const removed = await deps.callHost(routes.remoteAccess.removeDevice, { id: found.device.id })
  if (!removed?.ok) return refused(removed, deps.err)
  const fingerprint = printable(found.device.fingerprint)
  deps.out(
    found.approved
      ? `Revoked ${fingerprint}. The sockets it had open are closed.`
      : `Dismissed ${fingerprint}. It is no longer waiting.`,
  )
  return 0
}

/**
 * Runs a `devices` command with the host stopped, on `devices.json`. Waiting
 * devices live only in the running host's memory, so `approve` needs the host.
 */
export function devicesFromFile(command: DevicesCommand, deps: RemoteCliDeps): number {
  if (command.name === 'approve') {
    deps.err('Start the host, then run this again: devices wait for approval only in the running host')
    return 1
  }
  const saved = readDevices(deps)
  if (!saved) return 1
  const approved = savedAsListed(saved)
  if (command.name === 'devices') {
    if (approved.length === 0) deps.out('No devices are approved')
    const now = deps.now()
    for (const device of approved) deps.out(approvedLine(device, now))
    deps.out('Devices waiting for approval are known only to the running host.')
    return 0
  }
  const found = findDevice({ pending: [], approved }, command.fingerprint, deps)
  if (!found) return 1
  new DevicesRepository(devicesPath(deps.dataDir)).save(saved.filter((device) => device.id !== found.device.id))
  deps.out(`Revoked ${printable(found.device.fingerprint)}. The host uses the change from its next start.`)
  return 0
}

/** The `Devices:` line of `status` from the running host. False when the host refused the list. */
export async function hostDevicesLine(deps: RemoteCliDeps): Promise<boolean> {
  const devices = await deps.callHost(routes.remoteAccess.devices, {})
  if (!devices?.ok) {
    deps.out(`Devices:        not listed (${devices ? printable(devices.message) : 'the host stopped'})`)
    return false
  }
  deps.out(`Devices:        ${devices.data.approved.length} approved, ${devices.data.pending.length} waiting`)
  return true
}

/** The `Devices:` line of `status` from `devices.json`. False when the file is not valid. */
export function fileDevicesLine(deps: RemoteCliDeps): boolean {
  const saved = readDevices(deps)
  deps.out(`Devices:        ${saved ? `${saved.length} approved, waiting unknown (host not running)` : 'not readable'}`)
  return saved !== null
}

/** The approved devices in `devices.json`, or null after printing why the file is not valid. Never creates it. */
function readDevices(deps: RemoteCliDeps): SavedDevice[] | null {
  try {
    return new DevicesRepository(devicesPath(deps.dataDir)).load()
  } catch (error) {
    deps.err(messageOf(error))
    return null
  }
}

/** Saved devices as the host lists them: with fingerprints, newest first, and without their keys. */
function savedAsListed(saved: SavedDevice[]): ApprovedDevice[] {
  return [...saved].reverse().map(({ id, approvedAt }) => ({ id, fingerprint: fingerprintOf(id), approvedAt }))
}

/** Prints the waiting devices, then the approved ones, each newest first. */
function printDevices(devices: DevicesResponse, deps: RemoteCliDeps) {
  if (devices.pending.length === 0 && devices.approved.length === 0) {
    deps.out('No devices are approved or waiting')
    return
  }
  const now = deps.now()
  for (const device of devices.pending) {
    deps.out(`${printable(device.fingerprint)}  waiting, seen ${ageOf(device.firstSeenAt, now)}`)
  }
  for (const device of devices.approved) deps.out(approvedLine(device, now))
}

function approvedLine(device: ApprovedDevice, now: number): string {
  return `${printable(device.fingerprint)}  approved ${ageOf(device.approvedAt, now)}`
}

/** A device the typed fingerprint names, and which list it is in. */
type FoundDevice = { device: PendingDevice; approved: false } | { device: ApprovedDevice; approved: true }

/**
 * The one device whose fingerprint is `typed`, compared without case or dashes.
 * Prints why and answers null when none or more than one matches.
 */
function findDevice(devices: DevicesResponse, typed: string, deps: RemoteCliDeps): FoundDevice | null {
  const wanted = fingerprintKey(typed)
  const matches: FoundDevice[] = [
    ...devices.pending.map((device) => ({ device, approved: false as const })),
    ...devices.approved.map((device) => ({ device, approved: true as const })),
  ].filter(({ device }) => fingerprintKey(device.fingerprint) === wanted)
  const [match] = matches
  if (matches.length > 1) {
    deps.err(`More than one device has the fingerprint ${printable(typed)}, so nothing was changed`)
    return null
  }
  if (!match) {
    deps.err(`No device with the fingerprint ${printable(typed)} is waiting or approved. List them with: devices`)
    return null
  }
  return match
}

/** How long ago `iso` was, such as `3 min ago` or `2 days ago`. A time in the future counts as now. */
function ageOf(iso: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}
