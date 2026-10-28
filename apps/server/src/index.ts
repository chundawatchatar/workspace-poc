import { join } from 'node:path'
import { createApp } from './app'
import { parseAllowedOrigins } from './lib/security'
import { serverWebSocket } from './lib/websocket'
import { ChannelBridge } from './modules/bridge/bridge.service'
import { HttpForwarder } from './modules/forward/forward.service'
import { ConnectionLimiter } from './modules/limits/limits.service'
import { loadStaticSite } from './modules/static/static.service'
import { MachineRegistry } from './modules/tunnel/tunnel.service'

// Composition root: reads the environment, creates the registry, the forwarder, the bridge and the limiter, loads
// the built client, and starts the server.

const hostname = process.env.SERVER_HOST || '127.0.0.1'
const port = Number(process.env.SERVER_PORT || 4600)
const requestTimeoutMs = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 30_000)
const maxChannelsPerMachine = Number(process.env.SERVER_MAX_CHANNELS || 128)
// Resolved from this file, so the server finds the client however it is started.
const staticDir = process.env.SERVER_STATIC_DIR || join(import.meta.dir, '../../client/dist')
const allowedOrigins = parseAllowedOrigins(process.env.SERVER_ALLOWED_ORIGINS)
const trustProxy = process.env.SERVER_TRUST_PROXY === '1'

const site = await loadStaticSite(staticDir)
if (!site) console.log(`no client build in ${staticDir}, so only the relay is served`)

const registry = new MachineRegistry()
const forwarder = new HttpForwarder({ registry, requestTimeoutMs })
const bridge = new ChannelBridge({ registry, maxChannelsPerMachine })
const limiter = new ConnectionLimiter()
limiter.start()
const app = createApp({ registry, forwarder, bridge, limiter, site, allowedOrigins, trustProxy })
// The Bun server goes in as the env, which is where the client IP and socket upgrades come from.
const server = Bun.serve({
  hostname,
  port,
  fetch: (request, bunServer) => app.fetch(request, bunServer),
  websocket: serverWebSocket,
})
console.log(`server listening on http://${server.hostname}:${server.port}`)
