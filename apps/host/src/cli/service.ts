import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import { defaultDataDir } from '../lib/dataDir'
import { messageOf, printable } from '../remote-cli-output'
import { BACKGROUND_FLAG } from './args'
import { ensureDataFolder } from './data-folder'
import {
  logSize,
  logTail,
  readyHost,
  runningLine,
  STOP_TIMEOUT_MS,
  sendSignal,
  waitForExit,
  waitForHost,
  waitWhileStarting,
} from './lifecycle'
import { START_TIMEOUT_MS } from './process-files'
import { selfCommand } from './self'
import { launchdService } from './service-launchd'
import { systemdService } from './service-systemd'

// `corch service`: keeps the host running at login and after a crash, through the user's own service manager
// (launchd on macOS, the systemd user manager on Linux), never as root. While a data folder's service is installed,
// `start`, `stop`, `restart` and `status` act through the manager, so it knows whether the host should run.

/** What a command printed and its exit code. */
export interface CommandResult {
  code: number
  out: string
  err: string
}

/** Runs a command to its end. The one way this module reaches `launchctl`, `systemctl` and `loginctl`. */
export type RunCommand = (argv: string[]) => Promise<CommandResult>

/** Runs a command with this process's environment, so `systemctl --user` finds the user's bus. */
export const runCommand: RunCommand = async (argv) => {
  try {
    const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, out, err }
  } catch (error) {
    // The command is missing, as `systemctl` is on a system without systemd.
    return { code: 127, out: '', err: messageOf(error) }
  }
}

/** What the service commands need. `serviceDeps` fills in this process's own; tests replace parts. */
export interface ServiceDeps {
  dataDir: string
  platform: NodeJS.Platform
  uid: number
  /** The user's login name, for the linger hint. */
  user: string
  home: string
  env: Record<string, string | undefined>
  /** The command that runs `corch`, which the unit runs with `run --background --data-dir <dataDir>`. */
  self: string[]
  runCommand: RunCommand
  /** The folder for the unit file instead of the manager's per-user one. Only tests set it; no flag or setting does. */
  unitDir?: string
  /** True to enable the systemd unit for this boot only (`--runtime`), as a test's unit in `$XDG_RUNTIME_DIR` needs. */
  runtime?: boolean
  out: (line: string) => void
  err: (line: string) => void
}

/** This process's own service deps for a data folder, with `overrides` on top. */
export function serviceDeps(
  dataDir: string,
  env: Record<string, string | undefined>,
  overrides: Partial<ServiceDeps> = {},
): ServiceDeps {
  return {
    dataDir,
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    user: userInfo().username,
    home: homedir(),
    env,
    self: selfCommand(),
    runCommand,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    ...overrides,
  }
}

/** What a service manager is handed to build its service. */
export interface ManagerContext {
  /** The service name, from `serviceName`. */
  name: string
  dataDir: string
  programArguments: string[]
  uid: number
  user: string
  home: string
  env: Record<string, string | undefined>
  unitDir?: string
  runtime: boolean
  /** Runs a manager command. Null when it succeeded, else the manager's own message. */
  call: (argv: string[]) => Promise<string | null>
  /** Runs a command whatever its exit code, for questions such as whether a job is loaded. */
  run: RunCommand
}

/** One data folder's service under one manager. Each action answers null when it succeeded, else the manager's message. */
export interface ServiceManager {
  /** The name the manager knows it by: the launchd label or the systemd unit. */
  name: string
  unitPath: string
  /** The unit file's contents. */
  unitText: string
  /** Where the host's raw output goes, before its own log writer starts. */
  rawOutput: string
  /** Loads and starts the service, once its unit file is written. */
  load(): Promise<string | null>
  /** Stops and unloads the service, before its unit file is removed. */
  unload(): Promise<string | null>
  /** Tells the manager the unit file is gone. */
  afterRemove(): Promise<string | null>
  start(): Promise<string | null>
  stop(): Promise<string | null>
  restart(): Promise<string | null>
  /** How the manager sees the service, such as `loaded, running` or `inactive`. */
  state(): Promise<string>
  /** What the user should know about the service ending at logout. Null when it doesn't. */
  loginHint(): Promise<string | null>
}

/**
 * The service name for a data folder: `corch` for the default one, `corch-<first 12 hex of sha256(dataDir)>` for
 * any other, so each folder has at most one service and a test's folder never touches a real install.
 */
export function serviceName(dataDir: string, defaultDir: string): string {
  const folder = resolve(dataDir)
  if (folder === resolve(defaultDir)) return 'corch'
  return `corch-${createHash('sha256').update(folder).digest('hex').slice(0, 12)}`
}

/** The data folder's service on this platform, installed or not. Null on a platform with neither manager. */
export function serviceFor(deps: ServiceDeps): ServiceManager | null {
  const { platform, dataDir, home, env } = deps
  if (platform !== 'darwin' && platform !== 'linux') return null
  const context: ManagerContext = {
    name: serviceName(dataDir, defaultDataDir({ platform, home, env })),
    dataDir,
    programArguments: [...deps.self, 'run', BACKGROUND_FLAG, '--data-dir', dataDir],
    uid: deps.uid,
    user: deps.user,
    home,
    env,
    unitDir: deps.unitDir,
    runtime: deps.runtime ?? false,
    run: deps.runCommand,
    async call(argv) {
      const answer = await deps.runCommand(argv)
      if (answer.code === 0) return null
      const said = (answer.err.trim() || answer.out.trim()).split('\n').slice(0, 5).join(' ')
      return printable(`${argv.join(' ')} failed (exit ${answer.code})${said ? `: ${said}` : ''}`)
    },
  }
  return platform === 'darwin' ? launchdService(context) : systemdService(context)
}

/** The data folder's service when its unit file is where its manager reads it. Null when none is installed. */
export function installedService(deps: ServiceDeps): ServiceManager | null {
  const service = serviceFor(deps)
  return service && existsSync(service.unitPath) ? service : null
}

/** How long the service commands wait for the host, longer than `start` since launchd may hold a relaunch ~10 s. */
export const SERVICE_START_TIMEOUT_MS = 2 * START_TIMEOUT_MS

/**
 * Writes the unit file aside, readable by all (0644, as the managers expect), and renames it into place. Its folder
 * is created when missing; a leftover temp file is removed first and the new one created with `wx`, so nothing is
 * written through a link planted at its path.
 */
function writeUnitFile(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  writeFileSync(temp, text, { flag: 'wx', mode: 0o644 })
  // The umask may have taken bits away from the mode `writeFileSync` was given.
  chmodSync(temp, 0o644)
  renameSync(temp, path)
}

/** Says the host didn't answer, with the log written since `offset` and where its raw output went. Answers 1. */
function notAnswering(deps: ServiceDeps, service: ServiceManager, offset: number, what: string): number {
  deps.err(`${what}, but corch did not answer within ${SERVICE_START_TIMEOUT_MS / 1000} s.`)
  const tail = logTail(deps.dataDir, offset)
  if (tail) deps.err(tail)
  deps.err(`Its raw output is in ${service.rawOutput}`)
  return 1
}

/**
 * `corch service install`: writes the unit file, loads and starts the service, and returns once the host answers
 * with a new instance id. A host already running without the service is stopped first; its shells keep running.
 * Run again, it rewrites the file and reloads the service. When the manager refuses, the file is removed again.
 * Refused as root, before anything is written. Answers the exit code.
 */
export async function installService(deps: ServiceDeps): Promise<number> {
  const { dataDir, out, err } = deps
  if (deps.uid === 0) {
    err('corch service install sets up a service for your own user, never for root. Run it without sudo.')
    return 1
  }
  const service = serviceFor(deps)
  if (!service) {
    err(`corch service needs launchd (macOS) or the systemd user manager (Linux), not ${deps.platform}`)
    return 1
  }
  const refused = ensureDataFolder(dataDir)
  if (refused) {
    err(refused)
    return 1
  }

  const before = await waitWhileStarting(dataDir, Date.now() + START_TIMEOUT_MS)
  if (before.kind === 'starting') {
    err(`A host is starting (pid ${before.pid ?? 'unknown'}) but does not answer. Try again.`)
    return 1
  }
  if (existsSync(service.unitPath)) {
    const failed = await service.unload()
    if (failed) {
      err(failed)
      return 1
    }
  }
  if (before.kind === 'running') {
    const { run } = before
    // Still answering after any unload: it runs without the service, which would find the lock held.
    if (await readyHost(dataDir, (found) => found.instanceId === run.instanceId)) {
      out(`Stopping the host that runs without the service (pid ${run.pid}); its terminals keep running.`)
      sendSignal(run.pid, 'SIGTERM')
    }
    if (!(await waitForExit(dataDir, run, Date.now() + STOP_TIMEOUT_MS))) {
      err(`corch (pid ${run.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s`)
      return 1
    }
  }

  const offset = logSize(dataDir)
  writeUnitFile(service.unitPath, service.unitText)
  const failed = await service.load()
  if (failed) {
    rmSync(service.unitPath, { force: true })
    err(`The service manager refused the service, so it was not installed. ${failed}`)
    return 1
  }
  const previous = before.kind === 'running' ? before.run.instanceId : null
  const run = await waitForHost(dataDir, Date.now() + SERVICE_START_TIMEOUT_MS, (r) => r.instanceId !== previous)
  if (!run) return notAnswering(deps, service, offset, `Installed the service ${service.name}`)
  out(`Installed the service ${service.name}. corch is running at ${runningLine(run)}`)
  const hint = await service.loginHint()
  if (hint) out(hint)
  return 0
}

/**
 * `corch service uninstall`: stops and unloads the service and removes its unit file. The terminal daemon and its
 * shells keep running. With no service installed it says so and succeeds. Answers the exit code.
 */
export async function uninstallService(deps: ServiceDeps): Promise<number> {
  const { dataDir, out, err } = deps
  const service = serviceFor(deps)
  if (!service || !existsSync(service.unitPath)) {
    out(`No corch service is installed for ${dataDir}`)
    return 0
  }
  const before = await waitWhileStarting(dataDir, Date.now() + START_TIMEOUT_MS)
  const unloaded = await service.unload()
  if (unloaded) {
    err(unloaded)
    return 1
  }
  rmSync(service.unitPath, { force: true })
  const forgotten = await service.afterRemove()
  if (forgotten) {
    err(forgotten)
    return 1
  }
  out(`Removed the service ${service.name}. The terminals keep running; corch start runs the host without the service.`)
  if (before.kind === 'running' && !(await waitForExit(dataDir, before.run, Date.now() + STOP_TIMEOUT_MS))) {
    out(`A host still runs at ${runningLine(before.run)}; corch stop ends it.`)
  }
  return 0
}

/** `corch start` through the service: starts it unless a host answers already, then waits for the host. */
export async function startService(deps: ServiceDeps, service: ServiceManager): Promise<number> {
  const { dataDir, out, err } = deps
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS
  const before = await waitWhileStarting(dataDir, deadline)
  if (before.kind === 'running') {
    out(`corch is already running at ${runningLine(before.run)}`)
    return 0
  }
  const offset = logSize(dataDir)
  const failed = await service.start()
  if (failed) {
    err(failed)
    return 1
  }
  const run = await waitForHost(dataDir, deadline)
  if (!run) return notAnswering(deps, service, offset, `Started the service ${service.name}`)
  out(`corch is running at ${runningLine(run)}`)
  return 0
}

/**
 * `corch stop` through the service: the manager sends SIGTERM, the host exits 0, and the manager leaves it stopped.
 * The terminal daemon and its shells keep running.
 */
export async function stopService(deps: ServiceDeps, service: ServiceManager): Promise<number> {
  const { dataDir, out, err } = deps
  const state = await waitWhileStarting(dataDir, Date.now() + START_TIMEOUT_MS)
  if (state.kind === 'starting') {
    err(`A host is starting (pid ${state.pid ?? 'unknown'}) but does not answer. Try again.`)
    return 1
  }
  if (state.kind === 'none') {
    out('corch is not running')
    return 0
  }
  const failed = await service.stop()
  if (failed) {
    err(failed)
    return 1
  }
  if (!(await waitForExit(dataDir, state.run, Date.now() + STOP_TIMEOUT_MS))) {
    err(`corch (pid ${state.run.pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s`)
    return 1
  }
  out(`Stopped corch (pid ${state.run.pid}). The terminals keep running; corch terminals stop ends them.`)
  return 0
}

/** `corch restart` through the service: the manager restarts the host, which must answer with a new instance id. */
export async function restartService(deps: ServiceDeps, service: ServiceManager): Promise<number> {
  const { dataDir, out, err } = deps
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS
  const before = await waitWhileStarting(dataDir, deadline)
  if (before.kind === 'starting') {
    err(`A host is starting (pid ${before.pid ?? 'unknown'}) but does not answer. Try again.`)
    return 1
  }
  const previous = before.kind === 'running' ? before.run.instanceId : null
  const offset = logSize(dataDir)
  const failed = await service.restart()
  if (failed) {
    err(failed)
    return 1
  }
  const run = await waitForHost(dataDir, deadline, (r) => r.instanceId !== previous)
  if (!run) return notAnswering(deps, service, offset, `Restarted the service ${service.name}`)
  out(`corch is running at ${runningLine(run)}`)
  return 0
}

/** The `service:` line `corch status` ends with. */
export async function serviceLine(service: ServiceManager | null): Promise<string> {
  return service ? `  service: ${service.name} (${await service.state()})` : '  service: not installed'
}

/** Why `start` and `restart` refuse setting flags while a service is installed. */
export function flagsRefused(flags: string[]): string {
  return [
    `${flags.join(', ')} not used: the service always starts corch with the settings in config.json.`,
    'Save them with corch config set <key> <value>, then run corch restart.',
  ].join('\n')
}
