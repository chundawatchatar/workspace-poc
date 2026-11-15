import { existsSync, readFileSync } from 'node:fs'
import { logPath, previousLogPath } from './log-writer'

/** The background host's log, oldest first: `corch.log.1`, then `corch.log`. Null when neither exists. */
export function readLogs(dataDir: string): string | null {
  const files = [previousLogPath(dataDir), logPath(dataDir)].filter((file) => existsSync(file))
  if (files.length === 0) return null
  return files.map((file) => readFileSync(file, 'utf8')).join('')
}

/** `corch logs`: prints the log. Answers the exit code. */
export function logsCommand(dataDir: string): number {
  const text = readLogs(dataDir)
  if (text === null) {
    console.log(`There is no log yet: ${logPath(dataDir)}`)
    return 0
  }
  process.stdout.write(text)
  return 0
}
