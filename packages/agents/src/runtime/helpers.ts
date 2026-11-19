import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** A session file can be created a moment before `ps` reports its process as started, rounded to the second. */
const CLOCK_SLACK = 5000

/** The value after any of `flags`, as `--flag value` or `--flag=value`. */
export function flagValue(argv: string[], flags: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    for (const flag of flags) {
      if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
      if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1)
    }
  }
  return null
}

/** The first line of a file, read without loading the rest of a long transcript. */
export function firstLine(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString()
    const end = text.indexOf('\n')
    return end === -1 ? text : text.slice(0, end)
  } finally {
    closeSync(fd)
  }
}

/** A JSON object from session metadata, or null when the text is invalid or has another shape. */
export function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : null
  } catch {
    return null
  }
}

/** `.jsonl` files in `dirs` written since the process started, newest first across all of them. */
export function recentTranscripts(dirs: string[], since: number): string[] {
  return dirs
    .flatMap((dir) => {
      try {
        return readdirSync(dir)
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => join(dir, name))
      } catch {
        return []
      }
    })
    .flatMap((file) => {
      try {
        const { mtimeMs } = statSync(file)
        return mtimeMs >= since - CLOCK_SLACK ? [{ file, mtimeMs }] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.file)
}
