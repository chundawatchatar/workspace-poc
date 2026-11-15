import { lstatSync, mkdirSync } from 'node:fs'

// The packaged host keeps its keys, settings and process files in its data folder, so `start` and `run` use one
// only when it is this user's own. Only the folder itself is checked, never its parents: on macOS `/tmp` is a link.

/**
 * Creates `dataDir` (and its parents) with mode 0700 when it is missing, then checks it. Answers null when the folder
 * may be used, or the message to end the command with: it is a symbolic link, not a folder, owned by another user
 * than `uid`, or gives group or other users any permission. The folder's mode is never changed.
 */
export function ensureDataFolder(dataDir: string, uid = process.getuid?.()): string | null {
  const refuse = (why: string) => `corch will not use the data folder ${dataDir}: ${why}`
  if (!lstatSync(dataDir, { throwIfNoEntry: false })) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      return refuse(`it could not be created (${(error as NodeJS.ErrnoException).code ?? String(error)})`)
    }
  }
  // Checked after creating it too, so a folder swapped in meanwhile is caught.
  const stat = lstatSync(dataDir, { throwIfNoEntry: false })
  if (!stat) return refuse('it disappeared while it was being created')
  if (stat.isSymbolicLink()) return refuse('it is a symbolic link. Use the folder it points to instead')
  if (!stat.isDirectory()) return refuse('it is not a folder')
  if (uid !== undefined && stat.uid !== uid) return refuse(`it is owned by another user (uid ${stat.uid})`)
  const mode = stat.mode & 0o777
  if (mode & 0o077) {
    return refuse(
      `other users have access to it (mode ${mode.toString(8).padStart(4, '0')}). Run: chmod 700 ${dataDir}`,
    )
  }
  return null
}
