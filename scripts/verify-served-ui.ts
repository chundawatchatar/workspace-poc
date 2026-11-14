import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { websocket } from '@hono/bun'
import { SessionManager, shellProgram } from '@orch/terminal'
import { createApp } from '../apps/host/src/app'
import { accessKeysPath } from '../apps/host/src/modules/access/access.repository'
import {
  AgentTrackingRepository,
  agentTrackingPath,
} from '../apps/host/src/modules/agent-tracking/agent-tracking.repository'
import { AgentTrackingService } from '../apps/host/src/modules/agent-tracking/agent-tracking.service'
import { E2eSessions } from '../apps/host/src/modules/e2e/e2e.service'
import { EventHub } from '../apps/host/src/modules/events/events.service'
import { dataFile, LayoutRepository } from '../apps/host/src/modules/layout/layout.repository'
import { AuditLogRepository, auditLogPath } from '../apps/host/src/modules/remote-access/audit-log.repository'
import { AuditLogService } from '../apps/host/src/modules/remote-access/audit-log.service'
import { DevicesRepository, devicesPath } from '../apps/host/src/modules/remote-access/devices.repository'
import {
  LinkedAccountRepository,
  linkedAccountPath,
} from '../apps/host/src/modules/remote-access/linked-account.repository'
import {
  RemoteAccessRepository,
  remoteAccessPath,
} from '../apps/host/src/modules/remote-access/remote-access.repository'
import { RemoteAccessService } from '../apps/host/src/modules/remote-access/remote-access.service'
import { DaemonRepository } from '../apps/host/src/modules/terminals/daemon.repository'
import { stopDaemon } from '../apps/host/src/modules/terminals/daemon.service'
import { DaemonSession } from '../apps/host/src/modules/terminals/daemon-session.service'
import { SharedDaemon } from '../apps/host/src/modules/terminals/shared-daemon.service'
import { machineKeyFile } from '../apps/host/src/modules/tunnel/tunnel.repository'
import { loadUiSite } from '../apps/host/src/modules/ui/ui.service'

/**
 * End-to-end check that the host serves the built local UI on its own port:
 * it builds `apps/web`, starts a host on a free port with the build as its UI,
 * opens the page in a real browser (`Bun.WebView`: WebKit on macOS, Chrome
 * elsewhere, found through `BUN_CHROME_PATH`) and types into a terminal until
 * the shell's output shows in the page. The host is composed here, as
 * `apps/host/src/index.ts` composes it, but rooted at a temporary folder with
 * its own daemon runtime, so it never touches the repo's `apps/host/.data` or
 * a dev host's daemon. Run it with `bun run test:served-ui`.
 */

const root = resolve(import.meta.dir, '..')
const webDir = join(root, 'apps/web')
const daemonScript = join(root, 'apps/ptyd-bun/src/main.ts')
const MARKER = 'SERVED_UI_OK'
const TIMEOUT_MS = 20_000

const temp = mkdtempSync(join(tmpdir(), 'orch-served-ui-'))
const hostRoot = join(temp, 'host')
const projectRoot = join(temp, 'project')
mkdirSync(projectRoot)
// Read by `DaemonRepository`, so the daemon's socket and log live here, not in the dev host's runtime folder.
process.env.ORCH_PTY_RUNTIME = mkdtempSync(join(tmpdir(), 'orch-ui-pty-'))
const runtime = process.env.ORCH_PTY_RUNTIME

let step = 'build'
let cleanup: () => Promise<void> = async () => {}
const violations: string[] = []

async function finish(code: number): Promise<never> {
  try {
    await cleanup()
  } catch (error) {
    console.error(`cleaning up failed: ${error instanceof Error ? error.message : String(error)}`)
    code = 1
  }
  rmSync(temp, { recursive: true, force: true })
  rmSync(runtime, { recursive: true, force: true })
  process.exit(code)
}

function fail(message: string): Promise<never> {
  console.error(`FAIL at ${step}: ${message}`)
  return finish(1)
}

/** Polls `check` until it returns true, or fails the step after `TIMEOUT_MS`. */
async function waitFor(what: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  await fail(`timed out waiting for ${what}`)
}

/** True while something answers on the daemon's socket. */
function daemonAnswers(socket: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createConnection(socket)
    probe.on('connect', () => {
      probe.end()
      done(true)
    })
    probe.on('error', () => done(false))
  })
}

process.on('SIGINT', () => void fail('interrupted'))

const build = Bun.spawn(['bun', 'run', 'build'], { cwd: webDir, stdout: 'ignore', stderr: 'inherit' })
if ((await build.exited) !== 0) await fail('vite build failed')

step = 'host'
const ui = await loadUiSite(join(webDir, 'dist'))
if (!ui) await fail('the build has no index.html')

const hub = new EventHub()
const layout = new LayoutRepository(dataFile(hostRoot), projectRoot)
const agentTracking = new AgentTrackingService(new AgentTrackingRepository(agentTrackingPath(hostRoot)))
const daemons = new DaemonRepository(hostRoot)
const daemon = new SharedDaemon(daemons, [process.execPath, daemonScript], shellProgram(), () =>
  agentTracking.tracking(),
)
const sessions = new SessionManager(
  (session) => hub.broadcast({ type: 'session', session: session.info() }),
  (id) => hub.broadcast({ type: 'session.gone', id }),
  (id, cwd, cols, rows, onChange) => new DaemonSession(id, cwd, cols, rows, onChange, daemon),
)
const e2eSessions: E2eSessions = new E2eSessions({ machineKey: () => remoteAccess.signingKey() })
const remoteAccess = new RemoteAccessService({
  repository: new RemoteAccessRepository(remoteAccessPath(hostRoot)),
  linkedAccounts: new LinkedAccountRepository(linkedAccountPath(hostRoot)),
  devices: new DevicesRepository(devicesPath(hostRoot)),
  audit: new AuditLogService(new AuditLogRepository(auditLogPath(hostRoot))),
  e2eSessions,
  machineKeyFile: machineKeyFile(hostRoot),
  keysFile: accessKeysPath(hostRoot),
  env: {},
  handle: async () => new Response(null, { status: 404 }),
  openSocket: () => {
    throw new Error('this check opens no tunnel')
  },
})
const { app } = createApp({
  hub,
  layout,
  sessions,
  info: { home: projectRoot, shell: shellProgram(), platform: process.platform, projectRoot },
  daemonStartedAt: () => daemon.startedAt,
  machinePublicKey: () => remoteAccess.machinePublicKey(),
  access: () => remoteAccess.current(),
  remoteAccess,
  agentTracking,
  e2eSessions,
  ui,
})

// Port 0 picks a free port; the dev host's 4599 is refused so this never stands in for it.
let server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })
while (server.port === 4599) {
  server.stop(true)
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })
}
const origin = `http://127.0.0.1:${server.port}`
let view: Bun.WebView | null = null

cleanup = async () => {
  view?.close()
  Bun.WebView.closeAll()
  server.stop(true)
  sessions.shutdown()
  // Ends every shell the daemon owns, then the daemon itself.
  if ((await stopDaemon(daemons)) === 'stopped') {
    const deadline = Date.now() + 5000
    while ((await daemonAnswers(daemons.socket)) && Date.now() < deadline) await Bun.sleep(50)
    if (await daemonAnswers(daemons.socket)) throw new Error('the terminal daemon did not stop')
  }
}

try {
  step = 'page'
  view = new Bun.WebView({
    width: 1200,
    height: 800,
    backend: process.platform === 'darwin' ? 'webkit' : 'chrome',
    console: (type, ...args) => {
      const text = args.map(String).join(' ')
      if (/content security policy|refused to/i.test(text)) violations.push(text)
      if (type === 'error') console.error(`page: ${text}`)
    },
  })
  const page = view
  await page.navigate(`${origin}/`)
  // Listens for violations from here on; the ones during load show as inline scripts that never ran.
  await page.evaluate(
    "(window.__violations = [], document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI)), true)",
  )
  // The boot script sets the theme, the stream script defines `$R`, and the boundary script removes itself.
  const booted = await page.evaluate<boolean>(
    "document.documentElement.dataset.theme !== undefined && typeof self.$R === 'object' && ![...document.scripts].some((s) => s.textContent.includes('$tsr-stream-boundary'))",
  )
  if (!booted) await fail("the shell's inline scripts did not all run, so the CSP refused one")

  step = 'terminal'
  const workspace = layout.state.workspaces[0]
  if (!workspace) await fail('the layout has no workspace')
  await page.click(`a[href="/w/${encodeURIComponent(workspace?.id ?? '')}"]`, { timeout: TIMEOUT_MS })
  await page.click('.xterm', { timeout: TIMEOUT_MS })
  await waitFor('the terminal to be focused', () =>
    page.evaluate<boolean>("document.activeElement?.classList.contains('xterm-helper-textarea') ?? false"),
  )
  // A shell still starting up may drop what is typed ahead, so the command is typed again until its output shows.
  // It prints the marker in two parts, so the typed line never contains the marker itself. Keys are pressed one by
  // one: xterm ignores text inserted without key events.
  const shown = () =>
    page.evaluate<boolean>(
      `[...document.querySelectorAll('.xterm-rows')].some((rows) => rows.textContent.includes('${MARKER}'))`,
    )
  const deadline = Date.now() + TIMEOUT_MS
  while (!(await shown())) {
    if (Date.now() > deadline) await fail('timed out waiting for the shell output in the page')
    for (const key of "printf '%s_%s\\n' SERVED UI_OK") await page.press(key)
    // Shift+Enter, since a plain Enter reaches the page as an editing command that xterm ignores.
    await page.press('Enter', { modifiers: ['Shift'] })
    const settle = Date.now() + 2000
    while (Date.now() < settle && !(await shown())) await Bun.sleep(100)
  }

  step = 'csp'
  violations.push(...(await page.evaluate<string[]>('window.__violations')))
  if (violations.length) await fail(`the page reported CSP violations:\n${violations.join('\n')}`)

  console.log(`PASS: the host on ${origin} served the built UI and its terminal, with no CSP violation`)
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error))
}
await finish(0)
