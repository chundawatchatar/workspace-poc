import { existsSync, readFileSync } from 'node:fs'
import { logPath, previousLogPath } from './log-writer'

/** How many lines `corch logs` prints without `--all`. */
export const LOG_TAIL_LINES = 200

/** The background host's log, oldest first: `corch.log.1`, then `corch.log`. Null when neither exists. */
export function readLogs(dataDir: string): string | null {
  const files = [previousLogPath(dataDir), logPath(dataDir)].filter((file) => existsSync(file))
  if (files.length === 0) return null
  return files.map((file) => readFileSync(file, 'utf8')).join('')
}

/** The last `count` lines of `text`, keeping its final newline. A text with fewer lines is answered whole. */
export function lastLines(text: string, count: number): string {
  const ended = text.endsWith('\n')
  const lines = (ended ? text.slice(0, -1) : text).split('\n')
  if (lines.length <= count) return text
  return lines.slice(-count).join('\n') + (ended ? '\n' : '')
}

/** `corch logs`: prints the log's last lines, or all of it with `all`. Answers the exit code. */
export function logsCommand(dataDir: string, all = false): number {
  const text = readLogs(dataDir)
  if (text === null) {
    console.log(`There is no log yet: ${logPath(dataDir)}`)
    return 0
  }
  process.stdout.write(all ? text : lastLines(text, LOG_TAIL_LINES))
  return 0
}
