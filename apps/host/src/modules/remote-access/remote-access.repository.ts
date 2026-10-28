import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** The remote access setting as saved. It holds only addresses and a flag, nothing secret. */
export const remoteAccessSettings = z.object({
  /** True when the host should keep the tunnel open from its next start. */
  enabled: z.boolean(),
  /** The server address as entered. Null means none was saved. */
  serverUrl: z.string().nullable(),
  /** The client address for connect links. Null means it is derived from `serverUrl`. */
  clientUrl: z.string().nullable(),
})
export type RemoteAccessSettings = z.infer<typeof remoteAccessSettings>

/** Where the remote access setting is kept. */
export function remoteAccessPath(hostRoot: string) {
  return join(hostRoot, '.data', 'remote-access.json')
}

/** Loads and saves the remote access setting in one JSON file. */
export class RemoteAccessRepository {
  constructor(readonly file: string) {}

  /** The saved setting, or null when the file does not exist. A file that is not valid throws and is left as it is. */
  load(): RemoteAccessSettings | null {
    if (!existsSync(this.file)) return null
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      value = undefined
    }
    const parsed = remoteAccessSettings.safeParse(value)
    if (!parsed.success) {
      throw new Error(`the remote access setting in ${this.file} is not valid. Fix the file, or save the setting again`)
    }
    return parsed.data
  }

  /** Replaces the file in one step, so a crash never leaves half of it. */
  save(settings: RemoteAccessSettings) {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' })
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}
