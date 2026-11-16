import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { routes } from '@orch/shared'
import { daemonRuntimeDir } from '../modules/terminals/daemon.repository'
import { createHostCaller } from '../remote-cli'
import { runCli } from './cli'
import { instanceAt, readyHost } from './lifecycle'
import { readRunFile } from './process-files'
import { type ServiceDeps, serviceDeps, serviceFor } from './service'

// These tests install a service with the real launchd or systemd user manager, under a name made from a temporary
// data folder and from a unit file outside the user's own folders: on macOS a temporary folder, which
// `launchctl bootstrap` takes from any path; on Linux the user manager's runtime folder, enabled with `--runtime`,
// which is gone after logout, so a leftover never starts at login.

const entry = join(import.meta.dir, '..', 'main.ts')
const uid = process.getuid?.() ?? -1

/** Why the real manager can't be reached here, or null when it can. */
function unreachable(): string | null {
  if (process.platform === 'darwin') {
    const printed = Bun.spawnSync(['launchctl', 'print', `gui/${uid}`], { stdout: 'ignore', stderr: 'ignore' })
    return printed.exitCode === 0 ? null : `launchctl print gui/${uid} failed, so there is no GUI session to use`
  }
  if (process.platform === 'linux') {
    if (!process.env.XDG_RUNTIME_DIR) return 'XDG_RUNTIME_DIR is not set, so there is no user manager to use'
    const answer = Bun.spawnSync(['systemctl', '--user', 'is-system-running'], { stderr: 'ignore' })
    return answer.stdout.toString().trim() ? null : 'systemctl --user does not answer: there is no user bus'
  }
  return `there is no launchd or systemd on ${process.platform}`
}

const why = unreachable()
if (why) console.log(`Skipping the service tests against the real manager: ${why}`)

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CORCH_|HOST_|SERVER_URL|CLIENT_URL|ORCH_PTY_RUNTIME)/.test(key)),
)

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise((done) => server.close(done))
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  return address.port
}

const pidAlive = (pid: number) => Bun.spawnSync(['kill', '-0', String(pid)], { stderr: 'ignore' }).exitCode === 0
const pgrep = (...args: string[]) =>
  Bun.spawnSync(['pgrep', ...args])
    .stdout.toString()
    .split('\n')
    .filter(Boolean)
    .map(Number)

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Setup {
  dataDir: string
  port: number
  deps: Partial<ServiceDeps>
  /** Runs `corch <args> --data-dir <dataDir>` in this process, with the service's unit file in the test's folder. */
  corch: (...args: string[]) => Promise<number | null>
}

/**
 * A data folder, with a space in its path, whose `config.json` sets a free port. Afterwards the service is
 * uninstalled, the daemon stopped and the folders removed.
 */
async function setup(): Promise<Setup> {
  // Not `tmpdir()`: on macOS its path can be too long for the daemon's socket.
  const root = mkdtempSync('/tmp/corch-svc-')
  const dataDir = join(root, 'data dir')
  mkdirSync(dataDir, { mode: 0o700 })
  const port = await freePort()
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port }))
  const linux = process.platform === 'linux'
  const deps: Partial<ServiceDeps> = {
    unitDir: linux ? join(process.env.XDG_RUNTIME_DIR as string, 'systemd', 'user') : join(root, 'LaunchAgents'),
    runtime: linux,
    self: [process.execPath, '--no-env-file', '--define', 'ORCH_BUILD_ID="test-cli"', entry],
  }
  const corch = (...args: string[]) => runCli([...args, '--data-dir', dataDir], env, deps)
  cleanups.push(async () => {
    const uninstalled = await corch('service', 'uninstall')
    const terminals = await corch('terminals', 'stop')
    rmSync(root, { recursive: true, force: true })
    expect([uninstalled, terminals]).toEqual([0, 0])
  })
  return { dataDir, port, deps, corch }
}

const unitPath = (dataDir: string, deps: Partial<ServiceDeps>) =>
  serviceFor(serviceDeps(dataDir, env, deps))?.unitPath as string

describe.skipIf(why !== null)('corch service with the real manager', () => {
  test('a setting saved with config set applies after corch restart, and the unit file stays as it was', async () => {
    const { dataDir, port, deps, corch } = await setup()
    expect(await corch('service', 'install')).toBe(0)
    expect(await instanceAt(`http://127.0.0.1:${port}`)).not.toBeNull()
    const unit = readFileSync(unitPath(dataDir, deps), 'utf8')

    const next = await freePort()
    expect(await corch('config', 'set', 'port', String(next))).toBe(0)
    expect(await corch('restart')).toBe(0)
    expect(await instanceAt(`http://127.0.0.1:${next}`)).toBe(readRunFile(dataDir)?.record?.instanceId as string)
    expect(await instanceAt(`http://127.0.0.1:${port}`)).toBeNull()
    expect(readFileSync(unitPath(dataDir, deps), 'utf8')).toBe(unit)
  }, 90_000)

  test('the same daemon and shells outlive corch restart and a killed host, which the manager starts again', async () => {
    const { dataDir, corch } = await setup()
    expect(await corch('service', 'install')).toBe(0)
    const socket = join(daemonRuntimeDir(dataDir, uid), 'host.sock')
    await until(() => pgrep('-f', socket).length > 0, 'the terminal daemon')
    const [daemon] = pgrep('-f', socket) as [number]
    await until(() => pgrep('-P', String(daemon)).length > 0, 'the shells')
    const shells = pgrep('-P', String(daemon))
    const liveTerminals = async () => {
      const run = readRunFile(dataDir)?.record
      const answer = run ? await createHostCaller(run.url)(routes.system.daemon, {}).catch(() => null) : null
      return answer?.ok ? answer.data.liveTerminals : null
    }
    const live = await liveTerminals()
    expect(live).toBeGreaterThan(0)
    const survived = async () => {
      expect([daemon, ...shells].filter((pid) => !pidAlive(pid))).toEqual([])
      await until(async () => (await liveTerminals()) === live, 'the same live terminals')
    }

    const first = readRunFile(dataDir)?.record?.instanceId
    expect(await corch('restart')).toBe(0)
    const second = (await readyHost(dataDir))?.instanceId
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await survived()

    const pid = readRunFile(dataDir)?.record?.pid as number
    process.kill(pid, 'SIGKILL')
    await until(
      async () => (await readyHost(dataDir, (run) => run.instanceId !== second && run.pid !== pid)) !== null,
      'the manager to start the host again',
    )
    await survived()
  }, 120_000)
})
