import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DAEMON_PROTOCOL } from '@orch/terminal'
import { z } from 'zod'

const recordSchema = z.object({
  id: z.string(),
  token: z.string().uuid(),
  socket: z.string(),
  protocol: z.number().int(),
})
/** The private credentials and socket for one terminal. */
export type DaemonRecord = z.infer<typeof recordSchema>

/** Keeps terminal credentials separate from layout state and uses short, private socket paths. */
export class DaemonRepository {
  private readonly records: string
  readonly runtime: string

  constructor(hostRoot: string) {
    this.records = join(hostRoot, '.data', 'terminal-daemons')
    const app = createHash('sha256').update(resolve(hostRoot)).digest('hex').slice(0, 12)
    this.runtime = process.env.ORCH_PTY_RUNTIME ?? `/tmp/orchpty-${process.getuid?.() ?? 'user'}-${app}`
    for (const dir of [this.records, this.runtime]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const stat = lstatSync(dir)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error(`Terminal daemon directory must be private and owned by this user: ${dir}`)
      }
    }
  }

  /** Reads the record for `id`, or creates one with `createProtocol` for a terminal that has none yet. */
  get(id: string, createProtocol: number = DAEMON_PROTOCOL): DaemonRecord {
    const key = this.key(id)
    const file = join(this.records, `${key}.json`)
    if (existsSync(file)) {
      const record = recordSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      if (record.id !== id || record.socket !== join(this.runtime, `${key}.sock`)) {
        throw new Error('Terminal daemon record does not match its identity or runtime directory')
      }
      return record
    }
    const record: DaemonRecord = {
      id,
      token: randomUUID(),
      socket: join(this.runtime, `${key}.sock`),
      protocol: createProtocol,
    }
    if (Buffer.byteLength(record.socket) > 100)
      throw new Error('ORCH_PTY_RUNTIME produces a socket path over 100 bytes')
    try {
      writeFileSync(file, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.get(id)
      throw error
    }
    return record
  }

  list(): DaemonRecord[] {
    return readdirSync(this.records)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
      .map((name) => recordSchema.parse(JSON.parse(readFileSync(join(this.records, name), 'utf8'))))
      .map((record) => this.get(record.id))
  }

  remove(id: string) {
    const file = join(this.records, `${this.key(id)}.json`)
    if (existsSync(file)) unlinkSync(file)
  }

  private key(id: string) {
    return createHash('sha256').update(id).digest('hex').slice(0, 24)
  }
}
