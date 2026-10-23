import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const agentSchema = z.object({
  kind: z.enum(['claude', 'codex', 'opencode', 'cursor', 'pi', 'commandcode']),
  sessionId: z.string().nullable(),
  cwd: z.string(),
})

const recordSchema = z.object({
  id: z.string(),
  token: z.string().uuid(),
  /** The shell's last working directory, where it reopens if the daemon loses it. */
  cwd: z.string().optional(),
  /** The agent running in the terminal, kept so it can be resumed if the daemon loses the session. */
  agent: agentSchema.nullable().optional(),
})

/**
 * The credential a host presents when it attaches one terminal to the shared daemon, and what it needs to start
 * the terminal again should the daemon lose it. Records written before `cwd` and `agent` existed still parse.
 */
export type DaemonRecord = z.infer<typeof recordSchema>

/** Keeps one shared daemon's socket and the per-terminal credentials in private, short paths. */
export class DaemonRepository {
  private readonly records: string
  readonly runtime: string
  /** The single socket every terminal's connection shares. */
  readonly socket: string

  constructor(hostRoot: string) {
    this.records = join(hostRoot, '.data', 'terminal-daemons')
    const app = createHash('sha256').update(resolve(hostRoot)).digest('hex').slice(0, 12)
    this.runtime = process.env.ORCH_PTY_RUNTIME ?? `/tmp/orchpty-${process.getuid?.() ?? 'user'}-${app}`
    this.socket = join(this.runtime, 'host.sock')
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
    if (Buffer.byteLength(this.socket) > 100) throw new Error('ORCH_PTY_RUNTIME produces a socket path over 100 bytes')
  }

  /** Reads the credential for `id`, or creates one for a terminal that has none yet. */
  get(id: string): DaemonRecord {
    const key = this.key(id)
    const file = join(this.records, `${key}.json`)
    if (existsSync(file)) {
      const record = recordSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      if (record.id !== id) throw new Error('Terminal daemon record does not match its identity')
      return record
    }
    const record: DaemonRecord = { id, token: randomUUID() }
    try {
      writeFileSync(file, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.get(id)
      throw error
    }
    return record
  }

  /** Every readable record. One that is damaged is skipped and reported, so it cannot stop the host starting. */
  list(): DaemonRecord[] {
    return readdirSync(this.records)
      .filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
      .flatMap((name) => {
        try {
          const record = recordSchema.parse(JSON.parse(readFileSync(join(this.records, name), 'utf8')))
          return name === `${this.key(record.id)}.json` ? [record] : []
        } catch (error) {
          console.warn(`skipping unreadable terminal daemon record ${name}:`, error)
          return []
        }
      })
  }

  /** Saves what is known about a terminal's shell and agent. Writes only when something changed. */
  update(id: string, patch: Partial<Pick<DaemonRecord, 'cwd' | 'agent'>>): DaemonRecord {
    const current = this.get(id)
    const next = { ...current, ...patch }
    if (JSON.stringify(next) === JSON.stringify(current)) return current
    const file = join(this.records, `${this.key(id)}.json`)
    // Written aside and renamed into place, so a crash mid-write never leaves a record that fails to parse.
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    renameSync(temp, file)
    return next
  }

  remove(id: string) {
    const file = join(this.records, `${this.key(id)}.json`)
    if (existsSync(file)) unlinkSync(file)
  }

  private key(id: string) {
    return createHash('sha256').update(id).digest('hex').slice(0, 24)
  }
}
