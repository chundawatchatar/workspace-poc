import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DirListing } from '@orch/shared'

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

/** Lists the visible subfolders of `path` (after `expandDir`), sorted by name. Symlinks to folders count as folders. */
export function listDirs(path: string): DirListing {
  const dir = expandDir(path)
  if (!dir) return { path: null, parent: null, dirs: [] }
  const parent = dirname(dir)
  let dirs: string[] = []
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDir(join(dir, entry.name))))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  } catch {
    // Unreadable folder (permissions): show it as empty so the user can still go back up.
  }
  return { path: dir, parent: parent === dir ? null : parent, dirs }
}

/** Creates the folder `name` inside `parent` (after `expandDir`). `name` must be a single path segment. */
export function makeDir(parent: string, name: string): { path: string | null; error: string | null } {
  const dir = expandDir(parent)
  if (!dir) return { path: null, error: 'The parent folder does not exist.' }
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) {
    return { path: null, error: 'Enter a folder name without slashes.' }
  }
  const path = join(dir, trimmed)
  if (existsSync(path)) return { path: null, error: 'A file or folder with that name already exists.' }
  try {
    mkdirSync(path)
    return { path, error: null }
  } catch (error) {
    return { path: null, error: `Could not create the folder: ${(error as Error).message}` }
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
