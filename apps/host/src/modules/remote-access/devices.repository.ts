import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { deviceId, deviceJwk } from '@orch/shared'
import { z } from 'zod'
import { writeJsonAtomic } from './remote-access.repository'

/** An approved device as this machine keeps it: its id, its public key and when it was approved (an ISO string). */
const savedDevice = z.strictObject({ id: deviceId, publicKey: deviceJwk, approvedAt: z.iso.datetime() })
export type SavedDevice = z.infer<typeof savedDevice>

const savedDevices = z.array(savedDevice)

/** Where the approved devices are kept. */
export function devicesPath(hostRoot: string) {
  return join(hostRoot, '.data', 'devices.json')
}

/** Loads, saves and removes the approved devices in one JSON file. It holds public keys only. */
export class DevicesRepository {
  constructor(readonly file: string) {}

  /** The approved devices, or none when the file does not exist. A file that is not valid throws and is left as it is. */
  load(): SavedDevice[] {
    if (!existsSync(this.file)) return []
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      value = undefined
    }
    const parsed = savedDevices.safeParse(value)
    if (!parsed.success) {
      throw new Error(`the approved devices in ${this.file} are not valid. Delete the file to approve them again`)
    }
    return parsed.data
  }

  /** Replaces the file in one step, keeping only each device's fields. */
  save(devices: readonly SavedDevice[]) {
    writeJsonAtomic(
      this.file,
      devices.map(({ id, publicKey, approvedAt }) => ({ id, publicKey, approvedAt })),
    )
  }

  /** Removes the file. A missing file is fine. */
  remove() {
    rmSync(this.file, { force: true })
  }
}
