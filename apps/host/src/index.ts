import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { websocket } from '@hono/bun'
import { HOST_PORT, type HostInfo } from '@orch/shared'
import { createApp } from './app'
import { EventHub } from './modules/events/events.service'
import { dataFile, LayoutRepository } from './modules/layout/layout.repository'
import { SessionManager } from './modules/terminals/terminals.service'

// Composition root: creates the long-lived services, wires them together and starts the server.

const hostRoot = resolve(import.meta.dir, '..')
const projectRoot = resolve(hostRoot, '../..')

const info: HostInfo = {
  home: homedir(),
  shell: process.env.SHELL || '/bin/zsh',
  platform: process.platform,
  projectRoot,
}

const hub = new EventHub()
const layout = new LayoutRepository(dataFile(hostRoot), projectRoot)
const sessions = new SessionManager(
  (session) => hub.broadcast({ type: 'session', session: session.info() }),
  (id) => hub.broadcast({ type: 'session.gone', id }),
)

const app = createApp({ hub, layout, sessions, info })
const server = Bun.serve({ hostname: '127.0.0.1', port: HOST_PORT, fetch: app.fetch, websocket })
console.log(`host listening on http://${server.hostname}:${server.port}`)

function shutdown() {
  layout.flush()
  sessions.killAll()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
