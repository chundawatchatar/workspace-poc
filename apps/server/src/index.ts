import { createApp } from './app'
import { serverWebSocket } from './lib/websocket'
import { ChannelBridge } from './modules/bridge/bridge.service'
import { HttpForwarder } from './modules/forward/forward.service'
import { MachineRegistry } from './modules/tunnel/tunnel.service'

// Composition root: reads the environment, creates the registry, the forwarder and the bridge, and starts the server.

const hostname = process.env.SERVER_HOST || '127.0.0.1'
const port = Number(process.env.SERVER_PORT || 4600)
const requestTimeoutMs = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 30_000)
const maxChannelsPerMachine = Number(process.env.SERVER_MAX_CHANNELS || 128)

const registry = new MachineRegistry()
const forwarder = new HttpForwarder({ registry, requestTimeoutMs })
const bridge = new ChannelBridge({ registry, maxChannelsPerMachine })
const app = createApp({ registry, forwarder, bridge })
const server = Bun.serve({ hostname, port, fetch: app.fetch, websocket: serverWebSocket })
console.log(`server listening on http://${server.hostname}:${server.port}`)
