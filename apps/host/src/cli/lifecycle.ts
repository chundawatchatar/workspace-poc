import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { instanceResponse, routes } from '@orch/shared'
import type { SettingFlag } from '../modules/settings/settings.service'
import { createHostCaller } from '../remote-cli'
import { BACKGROUND_FLAG, settingFlagArgs } from './args'
import { logPath } from './log-writer'
import {
  type HostState,
  inspectHost,
  lockPath,
  pidAlive,
  type RunRecord,
  readRunFile,
  START_TIMEOUT_MS,
} from './process-files'

/** How long `stop` waits for the host to exit before it gives up, naming the pid. It never sends SIGKILL. */
export const STOP_TIMEOUT_MS = 10_000

/** The exit code of a `run` that found another host holding the lock, so the `start` that spawned it reports that one. */
export const LOCK_HELD_EXIT = 4

/** The exit code of `status` when no host runs. */
export const NOT_RUNNING_EXIT = 3

const POLL_MS = 100

/** Answers the instance id a host serves at `url`, or null when nothing answers there with one. */
export async function instanceAt(url: string): Promise<string | null> {
  try {
    const response = await fetch(`${url}${routes.system.instance.path}`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return null
    return instanceResponse.parse(await response.json()).instanceId
  } catch {
    return null
  }
}

/** The data folder's host state, with stale process files removed. */
export const hostState = (dataDir: string) => inspectHost(dataDir, instanceAt)

/** The host state once no host is starting, or at `deadline`, whichever comes first. */
async function waitWhileStarting(dataDir: string, deadline: number): Promise<HostState> {
  let state = await hostState(dataDir)
  while (state.kind === 'starting' && Date.now() < deadline) {
    await Bun.sleep(POLL_MS)
    state = await hostState(dataDir)
  }
  return state
}

const runningLine = (run: RunRecord) => `${run.url} (pid ${run.pid})`

/** What `start` needs: the data folder, the setting flags to pass on, and the command that runs `corch` again. */
export interface StartOptions {
  dataDir: string
  flags: Partial<Record<SettingFlag, string>>
  self: string[]
}

/**
 * `corch start`: runs the host in the background, in its own session with no terminal, and returns once it answers
 * with its own instance id at the address in its run file. A host that already runs is reported instead. If the
 * child exits first, or doesn't answer within the start timeout, it fails with the end of the log, killing the
 * child it spawned in the second case. Answers the exit code.
 */
export async function start({ dataDir, flags, self }: StartOptions): Promise<number> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + START_TIMEOUT_MS
  const before = await waitWhileStarting(dataDir, deadline)
  if (before.kind === 'running') {
    console.log(`corch is already running at ${runningLine(before.run)}`)
    return 0
  }

  // The child's raw output goes to the log too, so a crash before its own log writer starts still shows below.
  const log = openSync(logPath(dataDir), 'a', 0o600)
  const offset = fstatSync(log).size
  const [program, ...prefix] = self as [string, ...string[]]
  const child = spawn(
    program,
    [...prefix, 'run', BACKGROUND_FLAG, '--data-dir', dataDir, ...settingFlagArgs(flags)],
    // `detached` puts it in a session of its own, so the terminal that started it can close.
    { detached: true, stdio: ['ignore', log, log] },
  )
  closeSync(log)
  child.unref()
  let exit: number | null | undefined
  child.on('exit', (code, signal) => {
    exit = code ?? (signal ? 128 : 1)
  })

  while (Date.now() < deadline) {
    if (exit === LOCK_HELD_EXIT) {
      // Another `start` won the lock: report its host once it answers.
      const other = await waitWhileStarting(dataDir, deadline)
      if (other.kind === 'running') {
        console.log(`corch is already running at ${runningLine(other.run)}`)
        return 0
      }
      break
    }
    if (exit !== undefined) {
      console.error(`corch did not start: it exited with code ${exit}.`)
      printLogTail(dataDir, offset)
      return 1
    }
    const run = readRunFile(dataDir)?.record
    if (run && run.pid === child.pid && (await instanceAt(run.url)) === run.instanceId) {
      console.log(`corch is running at ${runningLine(run)}`)
      return 0
    }
    await Bun.sleep(POLL_MS)
  }

  if (exit === undefined && child.pid !== undefined) {
    process.kill(child.pid, 'SIGTERM')
    for (let tries = 0; tries < 20 && pidAlive(child.pid); tries++) await Bun.sleep(POLL_MS)
    if (pidAlive(child.pid)) process.kill(child.pid, 'SIGKILL')
  }
  console.error(`corch did not answer within ${START_TIMEOUT_MS / 1000} s, so it was stopped.`)
  printLogTail(dataDir, offset)
  return 1
}

/** Prints the last lines the log got since `offset`, or the log's last lines if it was rotated since. */
function printLogTail(dataDir: string, offset: number, lines = 20) {
  const path = logPath(dataDir)
  if (!existsSync(path)) return
  const text = readFileSync(path)
  const since = text.length >= offset ? text.subarray(offset) : text
  const tail = since.toString('utf8').trimEnd().split('\n').slice(-lines).join('\n')
  if (tail) console.error(`The log (${path}) ends with:\n${tail}`)
}

/**
 * `corch stop`: sends SIGTERM to the host the run file names, once its instance id answers at the recorded address,
 * and waits for it to exit and remove its files. The terminal daemon and its shells keep running. With no host it
 * says so and succeeds. Answers the exit code.
 */
export async function stop(dataDir: string): Promise<number> {
  const state = await waitWhileStarting(dataDir, Date.now() + START_TIMEOUT_MS)
  if (state.kind === 'starting') {
    console.error(`A host is starting (pid ${state.pid ?? 'unknown'}) but does not answer. Try again.`)
    return 1
  }
  if (state.kind === 'none') {
    console.log('corch is not running')
    return 0
  }
  const { pid, instanceId } = state.run
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  const gone = () =>
    !pidAlive(pid) &&
    readRunFile(dataDir)?.record?.instanceId !== instanceId &&
    !(existsSync(lockPath(dataDir)) && readFileSync(lockPath(dataDir), 'utf8').includes(instanceId))
  while (!gone() && Date.now() < deadline) await Bun.sleep(POLL_MS)
  if (!gone()) {
    console.error(`corch (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s`)
    return 1
  }
  console.log(`Stopped corch (pid ${pid}). The terminals keep running; corch terminals stop ends them.`)
  return 0
}

/** `corch restart`: stops the host, then starts it with the settings it has now. Answers the exit code. */
export async function restart(options: StartOptions): Promise<number> {
  const stopped = await stop(options.dataDir)
  return stopped === 0 ? start(options) : stopped
}

/**
 * `corch status`: prints whether the host runs, its URL, its pid and the terminal daemon it reports. Exits 0 when
 * it runs and 3 when it doesn't.
 */
export async function status(dataDir: string): Promise<number> {
  const state = await hostState(dataDir)
  if (state.kind === 'starting') {
    console.log(`corch is starting (pid ${state.pid ?? 'unknown'})`)
    return NOT_RUNNING_EXIT
  }
  if (state.kind === 'none') {
    console.log('corch is not running')
    return NOT_RUNNING_EXIT
  }
  const { url, pid } = state.run
  console.log(`corch is running\n  URL: ${url}\n  pid: ${pid}`)
  const answer = await createHostCaller(url)(routes.system.daemon, {}).catch(() => null)
  if (!answer?.ok) {
    console.log('  terminal daemon: unknown (the host did not say)')
    return 0
  }
  const daemon = answer.data
  const uptime = daemon.uptimeMs === null ? '' : `, up ${Math.round(daemon.uptimeMs / 1000)} s`
  const compatibility = daemon.compatibility ?? 'not heard from'
  console.log(`  terminal daemon: ${compatibility}, ${daemon.liveTerminals} live terminal(s)${uptime}`)
  return 0
}
