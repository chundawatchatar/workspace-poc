import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { websocket } from '@hono/bun'
import type { HostInfo } from '@orch/shared'
import { SessionManager, shellProgram } from '@orch/terminal'
import { createApp } from './app'
import { tunnelEnv } from './lib/principal'
import { accessKeysPath } from './modules/access/access.repository'
import { AgentTrackingRepository, agentTrackingPath } from './modules/agent-tracking/agent-tracking.repository'
import { AgentTrackingService } from './modules/agent-tracking/agent-tracking.service'
import { E2eSessions } from './modules/e2e/e2e.service'
import { EventHub } from './modules/events/events.service'
import { dataFile, LayoutRepository } from './modules/layout/layout.repository'
import { devAddresses, type RemoteAccessEnv } from './modules/remote-access/addresses.service'
import { AuditLogRepository, auditLogPath } from './modules/remote-access/audit-log.repository'
import { AuditLogService } from './modules/remote-access/audit-log.service'
import { DevicesRepository, devicesPath } from './modules/remote-access/devices.repository'
import { LinkedAccountRepository, linkedAccountPath } from './modules/remote-access/linked-account.repository'
import { RemoteAccessRepository, remoteAccessPath } from './modules/remote-access/remote-access.repository'
import { RemoteAccessService } from './modules/remote-access/remote-access.service'
import { settingsPath } from './modules/settings/settings.repository'
import type { Settings } from './modules/settings/settings.service'
import { daemonFactory, resendTracking, restoreTerminals } from './modules/terminals/daemon.service'
import { stopDaemonHint } from './modules/terminals/daemon-build'
import { machineKeyFile } from './modules/tunnel/tunnel.repository'
import type { UiSite } from './modules/ui/ui.service'

// Composition root: creates the long-lived services, wires them together and starts the server. It reads no
// environment variable and no `.env`: each entry point passes its folders, settings and addresses.

/** What an entry point gives the host. */
export interface HostOptions {
  /** Where the host keeps its files. */
  dataDir: string
  /** The folder a new workspace opens in. */
  projectRoot: string
  settings: Settings
  /** The terminal daemon's runtime folder (its socket, log and shims). */
  daemonRuntime: string
  /** The command that starts the terminal daemon. */
  daemonCommand: string[]
  /** This host's build, which a daemon must run for its terminals to be `current`. */
  build: string
  /** The built local UI to serve on the host's own port, or null for none. */
  ui: UiSite | null
  /** True for the packaged `corch`: the tunnel turns on only from its saved flag, and hints name `corch` commands. */
  packaged: boolean
  /** The dev host's `SERVER_URL` and `CLIENT_URL`; the packaged host passes none. */
  addresses: RemoteAccessEnv
  /** The loopback address to listen on. */
  hostname: string
  port: number
  /** The id this process answers on `routes.system.instance`; a fresh one when left out. */
  instanceId?: string
  /** Called once the server listens, with its URL and the process's instance id. */
  onListening?: (listening: { url: string; instanceId: string }) => void
  /** Called on SIGINT or SIGTERM after the host has saved its state, just before the process exits. */
  onShutdown?: () => void
}

/**
 * Starts the host and answers its URL and instance id. Throws when it can't listen, before any terminal is restored,
 * so a host that never served starts no shells.
 */
export function startHost(options: HostOptions): { url: string; instanceId: string } {
  const { dataDir, projectRoot, settings, packaged } = options
  // Fresh per process, so `corch` can tell this host from a later process that reuses its pid.
  const instanceId = options.instanceId ?? randomUUID()
  const info: HostInfo = {
    home: homedir(),
    shell: shellProgram(),
    platform: process.platform,
    projectRoot,
  }

  const hub = new EventHub()
  const layout = new LayoutRepository(dataFile(dataDir), projectRoot)
  const agentTracking = new AgentTrackingService(new AgentTrackingRepository(agentTrackingPath(dataDir)))
  const daemon = daemonFactory({
    dataDir,
    runtime: options.daemonRuntime,
    daemonCommand: options.daemonCommand,
    build: options.build,
    stopHint: stopDaemonHint(packaged),
    tracking: () => agentTracking.tracking(),
  })
  const sessions = new SessionManager(
    (session) => hub.broadcast({ type: 'session', session: session.info() }),
    (id) => hub.broadcast({ type: 'session.gone', id }),
    daemon.create,
  )
  // A changed answer reaches agents started afterwards in every open terminal, not only in new ones.
  agentTracking.onChange(() => resendTracking(sessions.list()))

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
    settingsFile: settingsPath(dataDir),
    addresses: devAddresses(settings, options.addresses),
    // A packaged host turns the tunnel on only from its saved flag; `SERVER_URL` turning it on is for dev.
    autoEnable: !packaged,
    handle: async (request, principal) => app.fetch(request, tunnelEnv(principal)),
    openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
  })

  const { app, sockets } = createApp({
    hub,
    layout,
    sessions,
    info,
    daemon: () => daemon.shared.report(),
    machinePublicKey: () => remoteAccess.machinePublicKey(),
    instanceId,
    access: () => remoteAccess.current(),
    remoteAccess,
    agentTracking,
    e2eSessions,
    ui: options.ui,
  })
  // The host controls this machine's shells, so it listens on loopback only; remote access goes through the relay.
  if (!['127.0.0.1', 'localhost', '::1'].includes(options.hostname)) {
    throw new Error('The host must listen on a loopback address')
  }
  const server = Bun.serve({ hostname: options.hostname, port: options.port, fetch: app.fetch, websocket })
  const url = `http://${server.hostname}:${server.port}`
  console.log(`host listening on ${url}`)

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

  remoteAccess.start()
  options.onListening?.({ url, instanceId })

  function shutdown() {
    clearInterval(inspector)
    try {
      remoteAccess.shutdown()
    } catch (error) {
      console.error(`saving access key use failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    layout.flush()
    sessions.shutdown()
    options.onShutdown?.()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return { url, instanceId }
}
