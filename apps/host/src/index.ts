import './env'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { websocket } from '@hono/bun'
import type { HostInfo } from '@orch/shared'
import { requiredEnv } from '@orch/shared/env'
import { SessionManager, shellProgram } from '@orch/terminal'
import { createApp } from './app'
import { tunnelEnv } from './lib/principal'
import { accessKeysPath } from './modules/access/access.repository'
import { AgentTrackingRepository, agentTrackingPath } from './modules/agent-tracking/agent-tracking.repository'
import { AgentTrackingService } from './modules/agent-tracking/agent-tracking.service'
import { EventHub } from './modules/events/events.service'
import { dataFile, LayoutRepository } from './modules/layout/layout.repository'
import { LinkedAccountRepository, linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { RemoteAccessRepository, remoteAccessPath } from './modules/remote-access/remote-access.repository'
import { RemoteAccessService } from './modules/remote-access/remote-access.service'
import { daemonFactory, resendTracking, restoreTerminals } from './modules/terminals/daemon.service'
import { machineSecretFile } from './modules/tunnel/tunnel.repository'

// Composition root: creates the long-lived services, wires them together and starts the server.

const hostRoot = resolve(import.meta.dir, '..')
const projectRoot = resolve(hostRoot, '../..')

const info: HostInfo = {
  home: homedir(),
  shell: shellProgram(),
  platform: process.platform,
  projectRoot,
}

const hub = new EventHub()
const layout = new LayoutRepository(dataFile(hostRoot), projectRoot)
const agentTracking = new AgentTrackingService(new AgentTrackingRepository(agentTrackingPath(hostRoot)))
const daemon = daemonFactory(hostRoot, () => agentTracking.tracking())
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

// The service reads `app` and `sockets` only once a tunnel carries traffic, after `createApp` has returned.
const remoteAccess = new RemoteAccessService({
  repository: new RemoteAccessRepository(remoteAccessPath(hostRoot)),
  linkedAccounts: new LinkedAccountRepository(linkedAccountPath(hostRoot)),
  secretFile: machineSecretFile(hostRoot),
  keysFile: accessKeysPath(hostRoot),
  env: { SERVER_URL: process.env.SERVER_URL, CLIENT_URL: process.env.CLIENT_URL },
  handle: async (request, principal) => app.fetch(request, tunnelEnv(principal)),
  openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
})

const { app, sockets } = createApp({
  hub,
  layout,
  sessions,
  info,
  daemonStartedAt: () => daemon.shared.startedAt,
  access: () => remoteAccess.current(),
  remoteAccess,
  agentTracking,
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
