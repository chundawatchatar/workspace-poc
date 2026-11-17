import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * The old remote access setting: an on/off flag that no host reads any more,
 * since the tunnel now runs exactly while the machine is connected to an
 * account. The file is kept only so `migrateRemoteAccessAddresses` can move the
 * addresses a folder from before `config.json` holds; it can be deleted.
 */
export const remoteAccessSettings = z.object({
  /** True when the old host kept the tunnel open. Nothing reads it now. */
  enabled: z.boolean(),
})
export type RemoteAccessSettings = z.infer<typeof remoteAccessSettings>

/**
 * The file as `load` reads it. A folder from before `config.json` also holds
 * the addresses here; only `migrateRemoteAccessAddresses` reads them.
 */
const storedRemoteAccess = remoteAccessSettings.extend({
  /** The server address as entered. Null means none was saved. */
  serverUrl: z.string().nullable().optional(),
  /** The client address for connect links. Null means it is derived from `serverUrl`. */
  clientUrl: z.string().nullable().optional(),
})
export type StoredRemoteAccess = z.infer<typeof storedRemoteAccess>

/** Where the old remote access setting is kept. */
export function remoteAccessPath(dataDir: string) {
  return join(dataDir, 'remote-access.json')
}

/** Loads and saves the old remote access setting in one JSON file, for the address migration only. */
export class RemoteAccessRepository {
  constructor(readonly file: string) {}

  /**
   * The saved setting, with the old addresses if the file still has them, or
   * null when the file does not exist. A file that is not valid throws and is
   * left as it is.
   */
  load(): StoredRemoteAccess | null {
    if (!existsSync(this.file)) return null
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      value = undefined
    }
    const parsed = storedRemoteAccess.safeParse(value)
    if (!parsed.success) {
      throw new Error(
        `the old remote access setting in ${this.file} is not valid. Delete the file: nothing uses it now`,
      )
    }
    return parsed.data
  }

  /** Replaces the file with the flag alone, in one step, so a crash never leaves half of it. */
  save({ enabled }: RemoteAccessSettings) {
    writeJsonAtomic(this.file, { enabled })
  }
}

/** Writes `value` as JSON to `file` through a temp file and a rename, so a crash never leaves half of it. */
export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
