import { websocket } from '@hono/bun'
import { MAX_TUNNEL_FRAME_BYTES } from '@orch/shared'
import { createApp } from './app'
import { MachineRegistry } from './modules/tunnel/tunnel.service'

// Composition root: reads the environment, creates the registry and starts the server.

const hostname = process.env.SERVER_HOST || '127.0.0.1'
const port = Number(process.env.SERVER_PORT || 4600)

const registry = new MachineRegistry()
const app = createApp({ registry })
const server = Bun.serve({
  hostname,
  port,
  fetch: app.fetch,
  // Bun refuses larger messages before buffering them, rather than leaving that to `decodeFrame`.
  websocket: { ...websocket, maxPayloadLength: MAX_TUNNEL_FRAME_BYTES },
})
console.log(`server listening on http://${server.hostname}:${server.port}`)
