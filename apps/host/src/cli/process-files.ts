import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

// The two files that say which process is this data folder's host. Bun has no `flock`, so the lock is a file
// created with `wx`, and a file whose process is gone, or that names a process which isn't the host, is stale.

/** How long a host may take from taking the lock to answering on its address. */
export const START_TIMEOUT_MS = 15_000

const lockRecord = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  startedAt: z.number(),
})
const runRecord = lockRecord.extend({ url: z.string().url() })

/** Who holds the lock: the host's pid, its instance id and when it took the lock, in epoch milliseconds. */
export type LockRecord = z.infer<typeof lockRecord>
/** A host that listens: the lock's fields and its URL. */
export type RunRecord = z.infer<typeof runRecord>

export const LOCK_FILE = 'corch.lock'
export const RUN_FILE = 'corch.run.json'

export const lockPath = (dataDir: string) => join(dataDir, LOCK_FILE)
export const runFilePath = (dataDir: string) => join(dataDir, RUN_FILE)

/** Takes the lock for `record`. False when another process holds it, stale or not. */
export function acquireLock(dataDir: string, record: LockRecord): boolean {
  try {
    writeFileSync(lockPath(dataDir), JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** A process file as found: its record, or null for one that doesn't parse, and when it was last written. */
export interface Found<T> {
  record: T | null
  writtenAt: number
}

function read<T>(path: string, schema: z.ZodType<T>): Found<T> | null {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (!stat) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let record: T | null = null
  try {
    record = schema.parse(JSON.parse(text))
  } catch {}
  return { record, writtenAt: stat.mtimeMs }
}

/** The lock, or null when there is none. */
export const readLock = (dataDir: string) => read(lockPath(dataDir), lockRecord)
/** The run file, or null when there is none. */
export const readRunFile = (dataDir: string) => read(runFilePath(dataDir), runRecord)

/** Writes the run file aside and renames it into place, readable by this user only. */
export function writeRunFile(dataDir: string, record: RunRecord) {
  const path = runFilePath(dataDir)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
  renameSync(temp, path)
}

/**
 * Removes the process files that still belong to `instanceId`, or, with null, the ones that don't parse. A file
 * another process has since written is left alone.
 */
export function removeProcessFiles(dataDir: string, instanceId: string | null) {
  for (const [path, found] of [
    [runFilePath(dataDir), readRunFile(dataDir)],
    [lockPath(dataDir), readLock(dataDir)],
  ] as const) {
    if (found && (found.record?.instanceId ?? null) === instanceId) rmSync(path, { force: true })
  }
}

/** True while a process with `pid` exists, even one owned by another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Answers the instance id a host serves at `url`, or null when nothing answers there with one. */
export type InstanceProbe = (url: string) => Promise<string | null>

/** What a data folder's process files say. */
export type HostState =
  | { kind: 'running'; run: RunRecord }
  | { kind: 'starting'; pid: number | null }
  | { kind: 'none' }

/**
 * Reads the process files and removes the stale ones. A file is stale when its pid is gone, or when its pid is
 * alive but its instance doesn't answer at the recorded address and the file is older than the start timeout, as
 * when the pid was reused. A file still younger than that belongs to a host that is starting. No pid is signalled.
 */
export async function inspectHost(dataDir: string, probe: InstanceProbe, now = Date.now()): Promise<HostState> {
  // A file that doesn't parse may be mid-write, so it counts as young for the start timeout after it was written.
  const live = (found: Found<LockRecord>) =>
    found.record
      ? pidAlive(found.record.pid) && now - found.record.startedAt < START_TIMEOUT_MS
      : now - found.writtenAt < START_TIMEOUT_MS

  let answering: RunRecord | null = null
  const run = readRunFile(dataDir)
  if (run) {
    const record = run.record
    if (record && pidAlive(record.pid) && (await probe(record.url)) === record.instanceId) answering = record
    else if (live(run)) return { kind: 'starting', pid: record?.pid ?? null }
    else removeProcessFiles(dataDir, record?.instanceId ?? null)
  }
  const lock = readLock(dataDir)
  if (lock && lock.record?.instanceId !== answering?.instanceId) {
    if (live(lock)) return { kind: 'starting', pid: lock.record?.pid ?? null }
    removeProcessFiles(dataDir, lock.record?.instanceId ?? null)
  }
  return answering ? { kind: 'running', run: answering } : { kind: 'none' }
}
