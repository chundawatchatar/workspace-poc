import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AuditLine, auditLine } from '@orch/shared'

/** The most lines the file holds. An append past it first cuts the file to `AUDIT_LOG_KEEP_LINES`. */
export const AUDIT_LOG_MAX_LINES = 1000
/** How many of the newest lines a cut keeps, before the new one. */
export const AUDIT_LOG_KEEP_LINES = 500

/** Where the remote access audit log is kept. */
export function auditLogPath(dataDir: string) {
  return join(dataDir, 'remote-audit.jsonl')
}

/**
 * Appends to and reads the remote access audit log, one JSON line per event.
 * It is capped at `AUDIT_LOG_MAX_LINES`, cut atomically. Its error messages
 * name the file, never what is in it.
 */
export class AuditLogRepository {
  /** The lines in the file, counted on the first append. Null until then. */
  private lines: number | null = null

  constructor(readonly file: string) {}

  /** Appends one line. When that would take the file past the cap, it is rewritten with the newest lines plus this one. */
  append(line: AuditLine) {
    const text = `${JSON.stringify(auditLine.parse(line))}\n`
    // A file deleted while the host runs starts the count again.
    if (this.lines === null || !existsSync(this.file)) this.lines = this.rawLines().length
    if (this.lines + 1 > AUDIT_LOG_MAX_LINES) {
      const kept = this.rawLines().slice(-AUDIT_LOG_KEEP_LINES)
      this.replace(`${kept.map((saved) => `${saved}\n`).join('')}${text}`)
      this.lines = kept.length + 1
      return
    }
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, text)
    this.lines += 1
  }

  /** Every line that parses against the entry schema, oldest first. Any other line is skipped. A missing file has none. */
  read(): AuditLine[] {
    return this.rawLines().flatMap((text) => {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        return []
      }
      const parsed = auditLine.safeParse(value)
      return parsed.success ? [parsed.data] : []
    })
  }

  /** The file's non-empty lines, unparsed. */
  private rawLines(): string[] {
    if (!existsSync(this.file)) return []
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      throw new Error(`the remote access audit log ${this.file} could not be read`)
    }
    return text.split('\n').filter((text) => text.trim() !== '')
  }

  /** Writes `text` through a temp file and a rename, so a crash never leaves half of it. */
  private replace(text: string) {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      writeFileSync(temp, text, { flag: 'wx' })
      renameSync(temp, this.file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}
