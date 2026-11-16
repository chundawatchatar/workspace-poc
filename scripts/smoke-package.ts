import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSocketUrl, routes } from '@orch/shared'
import { type LauncherTemplate, PLATFORMS, platformKey, uiHashesName } from '../apps/host/packaging/platforms'
import { NOT_RUNNING_EXIT } from '../apps/host/src/cli/lifecycle'
import { pidAlive, readRunFile, runFilePath } from '../apps/host/src/cli/process-files'
import { daemonRuntimeDir } from '../apps/host/src/modules/terminals/daemon.repository'
import { DAEMON_SUBCOMMAND } from '../apps/host/src/modules/terminals/daemon-build'
import { SANDBOX_CSP } from '../apps/host/src/modules/ui/ui.routes'
import { buildCsp } from '../apps/host/src/modules/ui/ui.service'

/**
 * `bun run test:package`: installs this platform's packed `corch` tarballs as
 * a user would, into a temporary npm prefix with no registry to reach, and
 * runs the whole lifecycle against the installed command: start, the served
 * UI, a terminal, stop, and ending the terminals. It runs `package:host`
 * first when the tarballs are missing. Every `corch` runs with a temporary
 * `HOME` and data folder, in a folder whose `.env` and `bunfig.toml` would
 * change its address, data folder and code if an executable read them. It
 * removes every temporary folder and process it made, on failure too, and
 * ends with a `PASS` line or names the step that failed.
 */

const root = resolve(import.meta.dir, '..')
const out = join(root, 'dist/package')
const MARKER = 'CORCH_SMOKE_OK'
const TIMEOUT_MS = 20_000

const target = PLATFORMS.find((candidate) => platformKey(candidate) === `${process.platform}-${process.arch}`)
if (!target) {
  console.error(`test:package: corch has no build for ${process.platform}-${process.arch}`)
  process.exit(1)
}
const { version } = JSON.parse(
  readFileSync(join(root, 'apps/host/packaging/npm/corch/package.json'), 'utf8'),
) as LauncherTemplate
const tarballs = [`corch-${version}.tgz`, `${target.npmName}-${version}.tgz`].map((name) => join(out, 'tarballs', name))
const uiHashesFile = join(out, 'build', uiHashesName(target))

// Resolved, since macOS's temporary folder is behind a symlink and process command lines show the real path.
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'corch-smoke-')))
const prefix = join(temp, 'prefix')
const home = join(temp, 'home')
const dataDir = join(temp, 'data')
const work = join(temp, 'work')
const marker = join(temp, 'preload-ran')
const decoys = { data: join(temp, 'decoy-data'), runtime: join(temp, 'decoy-runtime') }
const corch = join(prefix, 'bin/corch')
const runtime = daemonRuntimeDir(dataDir, process.getuid?.() ?? 'user')

let step = 'package'
/** Shells seen under the daemon, ended in the cleanup if a failure left them running. */
let shells: number[] = []

/** Every process whose command line contains `text`, as `[pid, command line]`. */
function processesWith(text: string): [number, string][] {
  const list = Bun.spawnSync(['ps', '-A', '-o', 'pid=', '-o', 'args='], { stdout: 'pipe' }).stdout.toString()
  return list
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null && match[2]?.includes(text) === true)
    .map((match) => [Number(match[1]), match[2] as string])
}

/** The children of `pid`. */
function childrenOf(pid: number): number[] {
  const list = Bun.spawnSync(['pgrep', '-P', String(pid)], { stdout: 'pipe' }).stdout.toString()
  return list.split('\n').filter(Boolean).map(Number)
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone.
  }
}

/** Ends whatever this run left behind, then removes every temporary folder. */
async function cleanup() {
  const left = () => [...processesWith(temp).map(([pid]) => pid), ...shells.filter(pidAlive)]
  for (const pid of left()) signal(pid, 'SIGTERM')
  const deadline = Date.now() + 3000
  while (left().length > 0 && Date.now() < deadline) await Bun.sleep(100)
  for (const pid of left()) signal(pid, 'SIGKILL')
  rmSync(temp, { recursive: true, force: true })
  rmSync(runtime, { recursive: true, force: true })
}

async function fail(message: string): Promise<never> {
  console.error(`FAIL at ${step}: ${message}`)
  const log = join(dataDir, 'corch.log')
  if (existsSync(log))
    console.error(`corch.log ends with:\n${readFileSync(log, 'utf8').split('\n').slice(-30).join('\n')}`)
  await cleanup()
  process.exit(1)
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

/** A port nothing listens on now, so connecting to it is refused. */
function unusedPort(): Promise<number> {
  return new Promise((done, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/** Polls `check` until it is true, or throws after `ms`. */
async function waitFor(what: string, ms: number, condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`)
    await Bun.sleep(100)
  }
}

// Only what a shell needs: no `CORCH_*`, `HOST_*` or `ORCH_*` from this shell reaches `npm` or `corch`. `/bin/sh`
// starts with no first-run questions in an empty `HOME`, as zsh would ask.
const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, SHELL: '/bin/sh' }
if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR

/** Runs a command to its end in the working folder, with its output captured. */
async function runCommand(command: string[]) {
  const child = Bun.spawn(command, { cwd: work, env, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr, text: `${stdout}${stderr}`.trim() }
}

/** Runs the installed `corch` with the temporary data folder. */
const runCorch = (...args: string[]) => runCommand([corch, ...args, '--data-dir', dataDir])

const sha256 = (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')

/** Opens a terminal over its socket and types a command until its output comes back. */
async function terminalRoundTrip(origin: string) {
  const path = buildSocketUrl(routes.sockets.terminal, { id: 'smoke-term', cwd: home, cols: 80, rows: 24 })
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}${path}`)
  socket.binaryType = 'arraybuffer'
  let screen = ''
  const decoder = new TextDecoder()
  socket.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) screen += decoder.decode(event.data, { stream: true })
  })
  await waitFor('the terminal socket to open', TIMEOUT_MS, () => {
    if (socket.readyState > WebSocket.OPEN) throw new Error('the terminal socket closed before it opened')
    return socket.readyState === WebSocket.OPEN
  })
  // A shell still starting may drop what is typed ahead, so the command is typed again until its output shows. It
  // prints the marker in two parts, so the typed line never contains the marker itself.
  const deadline = Date.now() + TIMEOUT_MS
  while (!screen.includes(MARKER)) {
    if (Date.now() > deadline) throw new Error(`no ${MARKER} from the shell within ${TIMEOUT_MS / 1000} s`)
    socket.send(JSON.stringify({ type: 'input', data: "printf '%s_%s\\n' CORCH SMOKE_OK\r" }))
    const settle = Date.now() + 2000
    while (Date.now() < settle && !screen.includes(MARKER)) await Bun.sleep(100)
  }
  socket.close()
}

/** Checks the page, every script and stylesheet it references, and every embedded file against the build. */
async function checkUi(origin: string) {
  const hashes = JSON.parse(readFileSync(uiHashesFile, 'utf8')) as Record<string, string>
  const page = await fetch(`${origin}/`, { headers: { accept: 'text/html' } })
  check(page.status === 200, `GET / answered ${page.status}`)
  const bytes = await page.arrayBuffer()
  const html = new TextDecoder().decode(bytes)
  const csp = page.headers.get('content-security-policy')
  check(!!csp, 'the page has no Content-Security-Policy')
  check(csp === buildCsp(html), 'the page CSP differs from the one a folder site gives')
  check(sha256(bytes) === hashes['/index.html'], 'the page differs from the build')

  const referenced = [
    ...[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1] as string),
    ...[...html.matchAll(/<link\b[^>]*>/g)]
      .filter(([tag]) => /\brel="[^"]*stylesheet[^"]*"/.test(tag))
      .map(([tag]) => tag.match(/\bhref="([^"]+)"/)?.[1] ?? ''),
  ]
  check(
    referenced.some((ref) => ref.endsWith('.js')),
    'the page references no script',
  )
  check(
    referenced.some((ref) => ref.endsWith('.css')),
    'the page references no stylesheet',
  )
  for (const ref of referenced) {
    const response = await fetch(new URL(ref, `${origin}/`))
    check(response.status === 200, `${ref} answered ${response.status}`)
  }

  for (const [urlPath, hash] of Object.entries(hashes)) {
    if (urlPath === '/index.html') continue
    const response = await fetch(`${origin}${urlPath}`)
    check(response.status === 200, `${urlPath} answered ${response.status}`)
    check(sha256(await response.arrayBuffer()) === hash, `${urlPath} differs from the build`)
    check(response.headers.get('content-security-policy') === SANDBOX_CSP, `${urlPath} is not sandboxed`)
    const cache = response.headers.get('cache-control')
    if (urlPath.startsWith('/assets/')) check(cache?.includes('immutable') === true, `${urlPath} is not immutable`)
  }
}

process.on('SIGINT', () => void fail('interrupted'))

try {
  if (!tarballs.every(existsSync) || !existsSync(uiHashesFile)) {
    console.log('test:package: no tarballs for this platform yet, so running package:host')
    const build = Bun.spawnSync([process.execPath, 'run', 'package:host'], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    check(build.exitCode === 0, `package:host failed (exit ${build.exitCode})`)
  }

  step = 'install'
  for (const dir of [home, work]) mkdirSync(dir, { recursive: true })
  const npmrc = join(temp, 'npmrc')
  writeFileSync(npmrc, '')
  // Nothing listens on the registry's port, so npm can fetch nothing: the four platform packages the launcher lists
  // are optional, and the one for this platform comes from its tarball.
  const registry = `http://127.0.0.1:${await unusedPort()}`
  const install = await runCommand([
    'npm',
    'install',
    '--global',
    '--prefix',
    prefix,
    `--registry=${registry}`,
    `--userconfig=${npmrc}`,
    `--cache=${join(temp, 'npm-cache')}`,
    '--fetch-retries=0',
    '--no-audit',
    '--no-fund',
    ...tarballs,
  ])
  check(install.code === 0, `npm install failed (exit ${install.code}):\n${install.text}`)
  check(existsSync(corch), `npm installed no ${corch}`)

  step = 'start'
  writeFileSync(
    join(work, '.env'),
    [
      'CORCH_PORT=1',
      `CORCH_DATA_DIR=${decoys.data}`,
      'HOST_HOST=0.0.0.0',
      'HOST_PORT=1',
      `ORCH_PTY_RUNTIME=${decoys.runtime}`,
      '',
    ].join('\n'),
  )
  writeFileSync(join(work, 'preload.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  writeFileSync(join(work, 'bunfig.toml'), 'preload = ["./preload.js"]\n\n[run]\npreload = ["./preload.js"]\n')
  let port = await unusedPort()
  while (port === 4599) port = await unusedPort()
  const origin = `http://127.0.0.1:${port}`
  const started = await runCorch('start', '--port', String(port))
  check(started.code === 0, `corch start exited ${started.code}:\n${started.text}`)
  check(started.stdout.includes(origin), `corch start did not print ${origin}:\n${started.text}`)
  const run = readRunFile(dataDir)?.record
  check(existsSync(runFilePath(dataDir)) && run?.url === origin, `no run file for ${origin} in ${dataDir}`)
  for (const [name, path] of Object.entries(decoys)) check(!existsSync(path), `the .env's decoy ${name} folder exists`)
  check(!existsSync(marker), "the working folder's bunfig.toml preload ran")
  // The flags win over `CORCH_PORT` and `CORCH_DATA_DIR`, so `config list`, which names a setting's source, shows
  // whether the `.env` reached the process at all.
  const settings = await runCorch('config', 'list')
  check(settings.code === 0 && !settings.text.includes('CORCH_PORT'), `corch read the .env:\n${settings.text}`)
  const hostPid = run?.pid ?? 0

  step = 'ui'
  await checkUi(origin)

  step = 'terminal'
  await terminalRoundTrip(origin)
  const daemons = processesWith(temp).filter(([, args]) => args.split(/\s+/).includes(DAEMON_SUBCOMMAND))
  check(daemons.length === 1, `expected one terminal daemon, found ${daemons.length}`)
  const daemonPid = daemons[0]?.[0] ?? 0
  shells = childrenOf(daemonPid)
  check(shells.length > 0, 'the terminal daemon has no shell')

  step = 'stop'
  const stopped = await runCorch('stop')
  check(stopped.code === 0, `corch stop exited ${stopped.code}:\n${stopped.text}`)
  check(!pidAlive(hostPid), `the host (pid ${hostPid}) still runs`)
  const status = await runCorch('status')
  check(status.code === NOT_RUNNING_EXIT, `corch status exited ${status.code}:\n${status.text}`)
  check(status.stdout.includes('not running'), `corch status did not say it is not running:\n${status.text}`)
  // npm links `corch` to the launcher, which runs the platform package's executable: both must say the same.
  const executable = join(prefix, 'lib/node_modules', target.npmName, 'bin/corch')
  const direct = await runCommand([executable, 'status', '--data-dir', dataDir])
  check(
    direct.code === status.code && direct.text === status.text,
    `the launcher's status differs from the executable's:\n${status.text}\n---\n${direct.text}`,
  )
  check(pidAlive(daemonPid), 'the terminal daemon stopped with the host')

  step = 'terminals stop'
  const ended = await runCorch('terminals', 'stop')
  check(ended.code === 0, `corch terminals stop exited ${ended.code}:\n${ended.text}`)
  await waitFor('the daemon and its shells to exit', 10_000, () => ![daemonPid, ...shells].some(pidAlive))
  const left = processesWith(temp)
  check(left.length === 0, `processes are left:\n${left.map(([pid, args]) => `${pid} ${args}`).join('\n')}`)
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error))
}

await cleanup()
console.log(
  `PASS: corch ${version} for ${platformKey(target)} installed from its tarballs and ran start, the UI, a terminal, stop and terminals stop`,
)
