import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { daemonRuntimeDir } from '../modules/terminals/daemon.repository'
import { instanceAt } from './lifecycle'
import { lockPath, runFilePath, START_TIMEOUT_MS } from './process-files'

const entry = join(import.meta.dir, '..', 'main.ts')

// Every `corch` here is the packaged entry run from source: the build id makes it packaged, and `--no-env-file`
// stands in for the compiled binary's build flags. Nothing reads the dev `.env`, so the dev host is never touched.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CORCH_|HOST_|SERVER_URL|CLIENT_URL|ORCH_PTY_RUNTIME)/.test(key)),
)

interface Run {
  code: number
  out: string
  err: string
}

/** Runs one `corch` command to its end, from `cwd`. */
async function corch(args: string[], cwd: string): Promise<Run> {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--define', 'ORCH_BUILD_ID="test-cli"', entry, ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, out, err }
}

/** A port nothing listens on, never one the dev host or web app use. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise((done) => server.close(done))
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  return address.port
}

const pidAlive = (pid: number) => Bun.spawnSync(['kill', '-0', String(pid)], { stderr: 'ignore' }).exitCode === 0
const processGroup = (pid: number) =>
  Number(
    Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)])
      .stdout.toString()
      .trim(),
  )
/** The pids whose command line contains `text`. */
const pids = (text: string) =>
  Bun.spawnSync(['pgrep', '-f', text]).stdout.toString().split('\n').filter(Boolean).map(Number)
const pidOf = (out: string) => Number(/\(pid (\d+)\)/.exec(out)?.[1])

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let tries = 0; tries < 200; tries++) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

interface Setup {
  dataDir: string
  cwd: string
  port: number
  /** Runs `corch <args> --data-dir <dataDir>` from the working folder. */
  run: (...args: string[]) => Promise<Run>
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * A data folder whose `config.json` sets a free port, and a working folder whose `.env` points every variable it
 * could at other values. Afterwards the host and the daemon are stopped and both folders removed.
 */
async function setup(): Promise<Setup> {
  // Not `tmpdir()`: on macOS its path can be too long for the daemon's socket.
  const dataDir = mkdtempSync('/tmp/corch-data-')
  const cwd = mkdtempSync('/tmp/corch-cwd-')
  const port = await freePort()
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port }))
  writeFileSync(
    join(cwd, '.env'),
    `CORCH_PORT=${await freePort()}\nCORCH_DATA_DIR=${join(cwd, 'env-data')}\nHOST_PORT=${await freePort()}\n`,
  )
  const run = (...args: string[]) => corch([...args, '--data-dir', dataDir], cwd)
  cleanups.push(async () => {
    await run('stop')
    await run('terminals', 'stop')
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })
  return { dataDir, cwd, port, run }
}

describe('corch', () => {
  test('start detaches a host on the configured port; status, remote and stop act on it and leave the daemon', async () => {
    const { dataDir, cwd, port, run } = await setup()
    const stopped = await run('remote', 'status')
    expect(stopped.code).toBe(0)
    expect(stopped.out).toContain('Remote access:')

    const started = await run('start')
    expect(started.code).toBe(0)
    const url = `http://127.0.0.1:${port}`
    expect(started.out).toContain(url)
    const pid = pidOf(started.out)
    // The starter has exited; the host runs on in a session of its own, so its group is not the test's.
    expect(processGroup(pid)).toBe(pid)
    expect(processGroup(pid)).not.toBe(processGroup(process.pid))
    const { instanceId } = JSON.parse(readFileSync(runFilePath(dataDir), 'utf8'))
    expect(await instanceAt(url)).toBe(instanceId)
    expect(statSync(runFilePath(dataDir)).mode & 0o777).toBe(0o600)

    const again = await run('start')
    expect([again.code, pidOf(again.out)]).toEqual([0, pid])
    const second = await run('run')
    expect(second.code).not.toBe(0)
    expect(second.err).toContain('already running')
    const status = await run('status')
    expect(status.code).toBe(0)
    expect(status.out).toContain(`pid: ${pid}`)
    expect(status.out).toContain('terminal daemon:')
    const remote = await run('remote', 'status')
    expect(remote.code).toBe(0)
    expect(remote.out).toContain('Remote access:')

    // A new host opens its layout's terminals, which start the daemon.
    const socket = join(daemonRuntimeDir(dataDir, process.getuid?.() ?? 'user'), 'host.sock')
    await until(() => pids(socket).length > 0, 'the terminal daemon')
    const [daemon] = pids(socket)

    const stop = await run('stop')
    expect(stop.code).toBe(0)
    expect(pidAlive(pid)).toBe(false)
    expect([existsSync(runFilePath(dataDir)), existsSync(lockPath(dataDir))]).toEqual([false, false])
    expect(pidAlive(daemon as number)).toBe(true)
    expect((await run('status')).code).toBe(3)
    expect((await run('stop')).code).toBe(0)
    // The `.env` in the working folder was never read.
    expect(existsSync(join(cwd, 'env-data'))).toBe(false)
  }, 60_000)

  test('two starts at once end with one host, which both report', async () => {
    const { dataDir, run } = await setup()
    const [a, b] = await Promise.all([run('start'), run('start')])
    expect([a.code, b.code]).toEqual([0, 0])
    expect(pidOf(a.out)).toBe(pidOf(b.out))
    expect(pids(`run --background --data-dir ${dataDir}`)).toEqual([pidOf(a.out)])
  }, 60_000)

  test('start fails with the end of the log when the port is taken, and leaves no process files', async () => {
    const { dataDir, port, run } = await setup()
    const taken = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('taken') })
    cleanups.push(() => taken.stop(true))
    const started = await run('start')
    expect(started.code).not.toBe(0)
    expect(started.err).toContain('corch did not start')
    expect(started.err).toContain('corch could not start')
    expect([existsSync(runFilePath(dataDir)), existsSync(lockPath(dataDir))]).toEqual([false, false])
  }, 60_000)

  test('stale process files are removed, and a live pid that is not a host is never signalled', async () => {
    const { dataDir, port, run } = await setup()
    const sleeper = Bun.spawn(['sleep', '120'])
    cleanups.push(() => sleeper.kill())
    const gone = Bun.spawn(['true'])
    await gone.exited
    const old = Date.now() - START_TIMEOUT_MS - 1000
    const stale = (pid: number) => ({ pid, instanceId: crypto.randomUUID(), startedAt: old })

    writeFileSync(lockPath(dataDir), JSON.stringify(stale(gone.pid)))
    expect((await run('status')).code).toBe(3)
    expect(existsSync(lockPath(dataDir))).toBe(false)

    const notHost = stale(sleeper.pid)
    writeFileSync(lockPath(dataDir), JSON.stringify(notHost))
    writeFileSync(runFilePath(dataDir), JSON.stringify({ ...notHost, url: `http://127.0.0.1:${await freePort()}` }))
    const stop = await run('stop')
    expect([stop.code, stop.out.trim()]).toEqual([0, 'corch is not running'])
    expect((await run('start')).out).toContain(`http://127.0.0.1:${port}`)
    expect(sleeper.exitCode).toBeNull()
    expect(sleeper.signalCode).toBeNull()
  }, 60_000)

  test('restart stops the host on its old port and starts it on the port config.json names now', async () => {
    const { dataDir, port, run } = await setup()
    const first = await run('start')
    expect(first.code).toBe(0)
    const next = await freePort()
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ port: next }))
    const restarted = await run('restart')
    expect(restarted.code).toBe(0)
    expect(restarted.out).toContain(`http://127.0.0.1:${next}`)
    expect(pidAlive(pidOf(first.out))).toBe(false)
    expect(await instanceAt(`http://127.0.0.1:${port}`)).toBeNull()
    expect(await instanceAt(`http://127.0.0.1:${next}`)).not.toBeNull()
  }, 60_000)

  test('an unknown command prints the usage and exits 2', async () => {
    const { run } = await setup()
    const unknown = await run('bogus')
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('Usage: corch')
  })
})

describe('the packaged CLI', () => {
  test('reaches no module that loads the root .env', () => {
    const forbidden = [
      join(import.meta.dir, '..', 'env.ts'),
      join(import.meta.dir, '../../../../packages/shared/src/env.ts'),
    ].map((file) => realpathSync(file))
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const seen = new Set<string>()
    const queue = [realpathSync(join(import.meta.dir, 'cli.ts'))]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      expect([file, source.includes('loadRootEnv(')]).toEqual([file, false])
      for (const { path } of transpiler.scanImports(source)) {
        const resolved = Bun.resolveSync(path, dirname(file))
        if (!resolved.startsWith('/')) continue
        const real = realpathSync(resolved)
        // Only the repo's own files: third-party packages never read the root `.env`.
        if (!real.includes('/node_modules/') && /\.tsx?$/.test(real)) queue.push(real)
      }
    }
    expect(seen.has(realpathSync(join(import.meta.dir, '..', 'host.ts')))).toBe(true)
    for (const file of forbidden) expect([file, seen.has(file)]).toEqual([file, false])
  })
})
