import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const base64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** One access key as stored: only its hash, never the key itself. */
export const accessKey = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** SHA-256 of the key, as unpadded base64url. */
  hash: base64url32,
  createdAt: z.iso.datetime(),
  /** When the key last authorized something. Null means never. */
  lastUsedAt: z.iso.datetime().nullable(),
})
export type AccessKey = z.infer<typeof accessKey>

const accessKeysFile = z.object({ keys: z.array(accessKey) })

/** Where the access keys are kept. */
export function accessKeysPath(hostRoot: string) {
  return join(hostRoot, '.data', 'access-keys.json')
}

/** Loads and saves the access keys in one JSON file, readable only by this user. */
export class AccessKeyRepository {
  constructor(readonly file: string) {}

  /**
   * The stored keys, or none when the file does not exist. A file that is not
   * valid throws and is left as it is. Error messages never include the file's
   * content.
   */
  load(): AccessKey[] {
    if (!existsSync(this.file)) return []
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // JSON.parse quotes the text it choked on, which could be a hash.
      value = undefined
    }
    const parsed = accessKeysFile.safeParse(value)
    if (!parsed.success) {
      throw new Error(
        `the access keys in ${this.file} are not valid. Fix the file, or delete it and run \`bun run host:rotate-key\``,
      )
    }
    return parsed.data.keys
  }

  /** Replaces the file in one step, so a crash never leaves half of it. */
  save(keys: AccessKey[]) {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temp, `${JSON.stringify({ keys }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}
