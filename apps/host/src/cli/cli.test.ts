import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

/** Runs one `corch` command to its end, from `cwd`, with `input` as its stdin. */
async function corch(args: string[], cwd: string, input?: string): Promise<Run> {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--define', 'ORCH_BUILD_ID="test-cli"', entry, ...args], {
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
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
  /** As `run`, with `input` typed on stdin. */
  typed: (input: string, ...args: string[]) => Promise<Run>
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
  const typed = (input: string, ...args: string[]) => corch([...args, '--data-dir', dataDir], cwd, input)
  cleanups.push(async () => {
    const stopped = await run('stop')
    const terminals = await run('terminals', 'stop')
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    // Checked only once both folders are gone, so a failing stop fails the test without leaving them behind.
    expect([stopped.code, terminals.code]).toEqual([0, 0])
  })
  return { dataDir, cwd, port, run, typed }
}

describe('corch', () => {
  test('start detaches a host on the configured port; status, remote and stop act on it and leave the daemon', async () => {
    const { dataDir, cwd, port, run } = await setup()
    const stopped = await run('remote', 'status')
    expect(stopped.code).toBe(0)
    expect(stopped.out).toContain('Connection:     not connected, tunnel host not running')

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
    expect(again.out).not.toContain('not applied')
    const flagged = await run('start', '--port', '5000')
    expect([flagged.code, pidOf(flagged.out)]).toEqual([0, pid])
    expect(flagged.out).toContain(url)
    expect(flagged.out).toContain('--port not applied')
    expect(flagged.out).toContain('corch restart')
    const second = await run('run')
    expect(second.code).not.toBe(0)
    expect(second.err).toContain('already running')
    const status = await run('status')
    expect(status.code).toBe(0)
    expect(status.out).toContain(`pid: ${pid}`)
    expect(status.out).toContain('terminal daemon:')
    expect(status.out).toContain('remote access: not connected')
    const remote = await run('remote', 'status')
    expect(remote.code).toBe(0)
    expect(remote.out).toContain('Connection:     not connected, tunnel off')

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

  test('start and run refuse a data folder other users can open, and spawn nothing', async () => {
    const { dataDir, run } = await setup()
    chmodSync(dataDir, 0o755)
    for (const command of ['start', 'run']) {
      const refused = await run(command)
      expect([command, refused.code]).toEqual([command, 1])
      expect(refused.err).toContain(dataDir)
      expect(refused.err).toContain(`chmod 700 ${dataDir}`)
    }
    expect(statSync(dataDir).mode & 0o777).toBe(0o755)
    expect(existsSync(lockPath(dataDir))).toBe(false)
    chmodSync(dataDir, 0o700)
  })

  test('start refuses a symlink at corch.log and spawns nothing', async () => {
    const { dataDir, cwd, run } = await setup()
    const outside = join(cwd, 'outside.log')
    writeFileSync(outside, 'untouched')
    symlinkSync(outside, join(dataDir, 'corch.log'))
    const started = await run('start')
    expect(started.code).toBe(1)
    expect(started.err).toContain(join(dataDir, 'corch.log'))
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    expect(pids(`run --background --data-dir ${dataDir}`)).toEqual([])
    expect(existsSync(lockPath(dataDir))).toBe(false)
  })

  test('an unknown command is named before the usage; a bad flag gets the usage alone', async () => {
    const { run } = await setup()
    const unknown = await run('frobnicate')
    expect(unknown.code).toBe(2)
    expect(unknown.err.startsWith('unknown command: frobnicate\nUsage: corch')).toBe(true)
    const badFlag = await run('start', '--bogus')
    expect(badFlag.code).toBe(2)
    expect(badFlag.err.startsWith('Usage: corch')).toBe(true)
  })

  test('logs prints the last 200 lines of both log files, and --all prints them all', async () => {
    const { dataDir, run } = await setup()
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `line ${from + i}\n`).join('')
    writeFileSync(join(dataDir, 'corch.log.1'), lines(0, 150))
    writeFileSync(join(dataDir, 'corch.log'), lines(150, 250))
    expect((await run('logs')).out).toBe(lines(50, 250))
    expect((await run('logs', '--all')).out).toBe(lines(0, 250))
  })

  test('a connected machine keeps its relay until disconnect, which asks first and names what is left to do', async () => {
    const { dataDir, port, run, typed } = await setup()
    // A spare port nothing listens on, so the tunnel only ever retries locally.
    const relay = `ws://127.0.0.1:${await freePort()}`
    const key = `oek_${'k'.repeat(43)}`
    expect((await run('config', 'set', 'relayUrl', relay)).code).toBe(0)
    const account = {
      name: 'Ada',
      maskedEmail: 'a***@example.com',
      serverUrl: relay,
      linkedAt: new Date().toISOString(),
    }
    writeFileSync(join(dataDir, 'linked-account.json'), JSON.stringify({ ...account, accountId: 'u1' }))
    const connectedTo = `connected to Ada (a***@example.com) through ${relay}`
    expect((await run('status')).out).toContain(`remote access: ${connectedTo} (host not running)`)
    for (const args of [
      ['config', 'set', 'relayUrl', 'wss://other.example.com'],
      ['config', 'unset', 'relayUrl'],
    ]) {
      const refused = await run(...args)
      expect([refused.code, refused.err.trim()]).toEqual([
        1,
        'This machine is connected to an account through its server address. Run corch disconnect first.',
      ])
    }
    // Checked before any host is called, and never echoed.
    const bad = await run('connect', '--email', 'not-an-email', '--key', key)
    expect([bad.code, bad.err.trim()]).toEqual([1, 'That is not an email address'])
    for (const old of [
      ['remote', 'link', key],
      ['remote', 'on'],
    ]) {
      expect((await run(...old)).err).toContain('connect --email <email> --key <key>')
    }

    expect((await run('start')).code).toBe(0)
    expect((await run('status')).out).toContain(`remote access: ${connectedTo}`)
    expect((await run('config', 'set', 'relayUrl', 'wss://other.example.com')).code).toBe(1)
    const kept = await typed('n\n', 'disconnect')
    expect(kept.code).toBe(1)
    expect(kept.out).toContain('Disconnect this machine from Ada (a***@example.com)? [y/N]')
    expect((await run('remote', 'status')).out).toContain('Connection:     connected')

    // The tunnel never connected, so the server could not remove the machine from the account's list.
    const disconnected = await run('disconnect', '--yes')
    expect(disconnected.code).toBe(0)
    expect(disconnected.out).toContain('Remove it in the client')
    expect(existsSync(join(dataDir, 'linked-account.json'))).toBe(false)
    expect((await run('status')).out).toContain('remote access: not connected')
    expect((await run('config', 'set', 'relayUrl', 'wss://other.example.com')).code).toBe(0)
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({
      port,
      relayUrl: 'wss://other.example.com',
    })
  }, 60_000)
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
