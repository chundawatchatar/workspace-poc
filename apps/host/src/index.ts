import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { websocket } from '@hono/bun'
import { HOST_PORT, type HostInfo } from '@orch/shared'
import { SessionManager, shellProgram } from '@orch/terminal'
import { createApp } from './app'
import { EventHub } from './modules/events/events.service'
import { dataFile, LayoutRepository } from './modules/layout/layout.repository'
import { daemonFactory, restoreTerminals } from './modules/terminals/daemon.service'
import { loadOrCreateMachineSecret, machineSecretFile } from './modules/tunnel/tunnel.repository'
import { parseServerUrl, TunnelClient } from './modules/tunnel/tunnel.service'

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
const daemon = daemonFactory(hostRoot)
const sessions = new SessionManager(
  (session) => hub.broadcast({ type: 'session', session: session.info() }),
  (id) => hub.broadcast({ type: 'session.gone', id }),
  daemon.create,
)
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

const { app } = createApp({ hub, layout, sessions, info, daemonStartedAt: () => daemon.shared.startedAt })
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: HOST_PORT,
  fetch: app.fetch,
  websocket,
})
console.log(`host listening on http://${server.hostname}:${server.port}`)

const tunnel = startTunnel(process.env.SERVER_URL)

/** Opens the tunnel to the server when `SERVER_URL` is set. Any problem leaves the host running locally only. */
function startTunnel(serverUrl: string | undefined): TunnelClient | null {
  if (!serverUrl) return null
  const url = parseServerUrl(serverUrl)
  if (!url) {
    console.error(
      'SERVER_URL must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost. Running without a tunnel',
    )
    return null
  }
  let secret: string
  try {
    secret = loadOrCreateMachineSecret(machineSecretFile(hostRoot))
  } catch (error) {
    // The repository's messages never contain the secret.
    console.error(`no tunnel: ${error instanceof Error ? error.message : 'the machine secret could not be read'}`)
    return null
  }
  // The access-key job wraps `handle` with the key check; until then the origin check is all there is.
  console.warn(
    'warning: tunneled requests are not access-checked yet. Anyone who knows this machine id can reach its API through the server',
  )
  const client = new TunnelClient({ url, secret, handle: async (request) => app.fetch(request) })
  client.start()
  return client
}

function shutdown() {
  clearInterval(inspector)
  tunnel?.stop()
  layout.flush()
  sessions.shutdown()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
