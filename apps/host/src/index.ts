import './env'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { websocket } from '@hono/bun'
import type { HostInfo } from '@orch/shared'
import { optionalEnv, requiredEnv } from '@orch/shared/env'
import { SessionManager, shellProgram } from '@orch/terminal'
import { createApp } from './app'
import { devDaemonCommand, devDaemonRuntime, devDataDir, repoRoot } from './env'
import { tunnelEnv } from './lib/principal'
import { accessKeysPath } from './modules/access/access.repository'
import { AgentTrackingRepository, agentTrackingPath } from './modules/agent-tracking/agent-tracking.repository'
import { AgentTrackingService } from './modules/agent-tracking/agent-tracking.service'
import { E2eSessions } from './modules/e2e/e2e.service'
import { EventHub } from './modules/events/events.service'
import { dataFile, LayoutRepository } from './modules/layout/layout.repository'
import { AuditLogRepository, auditLogPath } from './modules/remote-access/audit-log.repository'
import { AuditLogService } from './modules/remote-access/audit-log.service'
import { DevicesRepository, devicesPath } from './modules/remote-access/devices.repository'
import { LinkedAccountRepository, linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { RemoteAccessRepository, remoteAccessPath } from './modules/remote-access/remote-access.repository'
import { RemoteAccessService } from './modules/remote-access/remote-access.service'
import { daemonFactory, resendTracking, restoreTerminals } from './modules/terminals/daemon.service'
import { machineKeyFile } from './modules/tunnel/tunnel.repository'
import { loadUiSite } from './modules/ui/ui.service'

// Composition root: creates the long-lived services, wires them together and starts the server.

// The dev host's folders, from `env.ts`. A packaged entry point will pass its own.
const dataDir = devDataDir
const projectRoot = repoRoot

const info: HostInfo = {
  home: homedir(),
  shell: shellProgram(),
  platform: process.platform,
  projectRoot,
}

// The built local UI, served on the host's own port. Unset serves none; a relative path resolves from the repo root.
const staticDir = optionalEnv('HOST_STATIC_DIR')
const uiDir = staticDir === undefined ? null : resolve(projectRoot, staticDir)
const ui = uiDir === null ? null : await loadUiSite(uiDir)
if (uiDir !== null && !ui) {
  console.error(`HOST_STATIC_DIR has no index.html: ${uiDir}`)
  process.exit(1)
}

const hub = new EventHub()
const layout = new LayoutRepository(dataFile(dataDir), projectRoot)
const agentTracking = new AgentTrackingService(new AgentTrackingRepository(agentTrackingPath(dataDir)))
const daemon = daemonFactory({
  dataDir,
  runtime: devDaemonRuntime(),
  daemonCommand: devDaemonCommand,
  tracking: () => agentTracking.tracking(),
})
const sessions = new SessionManager(
  (session) => hub.broadcast({ type: 'session', session: session.info() }),
  (id) => hub.broadcast({ type: 'session.gone', id }),
  daemon.create,
)
// A changed answer reaches agents started afterwards in every open terminal, not only in new ones.
agentTracking.onChange(() => resendTracking(sessions.list()))
void restoreTerminals(layout, sessions, daemon)

// Polls what each terminal is running. A slow round is never overlapped by the next.
let inspecting = false
const inspector = setInterval(() => {
  if (inspecting) return
  inspecting = true
  sessions
    .inspect()
    .catch((error) => console.error('inspecting terminals failed', error))
    .finally(() => {
      inspecting = false
    })
}, 2000)

// In memory only. It reads the machine key at each open, and remote access closes its sessions with its sockets.
const e2eSessions: E2eSessions = new E2eSessions({ machineKey: () => remoteAccess.signingKey() })

// The service reads `app` and `sockets` only once a tunnel carries traffic, after `createApp` has returned.
const remoteAccess = new RemoteAccessService({
  repository: new RemoteAccessRepository(remoteAccessPath(dataDir)),
  linkedAccounts: new LinkedAccountRepository(linkedAccountPath(dataDir)),
  devices: new DevicesRepository(devicesPath(dataDir)),
  audit: new AuditLogService(new AuditLogRepository(auditLogPath(dataDir))),
  e2eSessions,
  machineKeyFile: machineKeyFile(dataDir),
  keysFile: accessKeysPath(dataDir),
  env: { SERVER_URL: optionalEnv('SERVER_URL'), CLIENT_URL: optionalEnv('CLIENT_URL') },
  handle: async (request, principal) => app.fetch(request, tunnelEnv(principal)),
  openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
})

const { app, sockets } = createApp({
  hub,
  layout,
  sessions,
  info,
  daemonStartedAt: () => daemon.shared.startedAt,
  machinePublicKey: () => remoteAccess.machinePublicKey(),
  access: () => remoteAccess.current(),
  remoteAccess,
  agentTracking,
  e2eSessions,
  ui,
})
// The host controls this machine's shells, so it listens on loopback only; remote access goes through the relay.
const hostname = requiredEnv('HOST_HOST')
if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) throw new Error('HOST_HOST must be a loopback address')
const server = Bun.serve({
  hostname,
  port: Number(requiredEnv('HOST_PORT')),
  fetch: app.fetch,
  websocket,
})
console.log(`host listening on http://${server.hostname}:${server.port}`)

remoteAccess.start()

function shutdown() {
  clearInterval(inspector)
  try {
    remoteAccess.shutdown()
  } catch (error) {
    console.error(`saving access key use failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  layout.flush()
  sessions.shutdown()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
