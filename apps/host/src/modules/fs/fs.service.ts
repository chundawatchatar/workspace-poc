import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Resolves `~` and `~/…`, and returns null unless the result is an existing directory. */
export function expandDir(path: string): string | null {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded)) return null
  try {
    return existsSync(expanded) && statSync(expanded).isDirectory() ? resolve(expanded) : null
  } catch {
    return null
  }
}
