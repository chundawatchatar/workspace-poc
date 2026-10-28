import { websocket } from '@hono/bun'
import { MAX_TUNNEL_FRAME_BYTES } from '@orch/shared'
import { createApp } from './app'
import { HttpForwarder } from './modules/forward/forward.service'
import { MachineRegistry } from './modules/tunnel/tunnel.service'

// Composition root: reads the environment, creates the registry and the forwarder, and starts the server.

const hostname = process.env.SERVER_HOST || '127.0.0.1'
const port = Number(process.env.SERVER_PORT || 4600)
const requestTimeoutMs = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 30_000)

const registry = new MachineRegistry()
const forwarder = new HttpForwarder({ registry, requestTimeoutMs })
const app = createApp({ registry, forwarder })
const server = Bun.serve({
  hostname,
  port,
  fetch: app.fetch,
  // Bun refuses larger messages before buffering them, rather than leaving that to `decodeFrame`.
  websocket: { ...websocket, maxPayloadLength: MAX_TUNNEL_FRAME_BYTES },
})
console.log(`server listening on http://${server.hostname}:${server.port}`)
