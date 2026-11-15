import { appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

/** How big `corch.log` may grow before it is moved to `corch.log.1`, so the two never pass twice this on disk. */
export const LOG_CAP_BYTES = 5 * 1024 * 1024

export const LOG_FILE = 'corch.log'

export const logPath = (dataDir: string) => join(dataDir, LOG_FILE)
/** The log before the current one, which `corch.log` replaces when it passes the cap. */
export const previousLogPath = (dataDir: string) => `${logPath(dataDir)}.1`

/**
 * Appends to a log file that never passes `cap`: a write that would pass it first moves the file to `<path>.1`,
 * replacing the one there. The size is read from the file at each write, since the host's raw output appends to it
 * too. A single write longer than the cap keeps only its start.
 */
export class CappedLog {
  constructor(
    readonly path: string,
    readonly cap = LOG_CAP_BYTES,
  ) {}

  write(text: string) {
    let bytes = Buffer.from(text)
    if (bytes.length > this.cap) bytes = bytes.subarray(0, this.cap)
    const size = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0
    if (size > 0 && size + bytes.length > this.cap) renameSync(this.path, `${this.path}.1`)
    appendFileSync(this.path, bytes, { mode: 0o600 })
  }
}

/** Sends every `console` line to `log` instead of the terminal, each with the time it was written. */
export function captureConsole(log: CappedLog) {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[method] = (...args: unknown[]) => log.write(`${new Date().toISOString()} ${format(...args)}\n`)
  }
}
