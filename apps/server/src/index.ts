import './env'
import { join } from 'node:path'
import { createDomain } from '@orch/domain'
import { type ApiModule, createApp } from './app'
import { loadServerConfig, ServerConfigError } from './lib/config'
import { checkDatabase, databaseLocation } from './lib/database'
import { parseAllowedOrigins } from './lib/security'
import { serverWebSocket } from './lib/websocket'
import { ChannelBridge } from './modules/bridge/bridge.service'
import { HttpForwarder } from './modules/forward/forward.service'
import { ConnectionLimiter } from './modules/limits/limits.service'
import { loadStaticSite } from './modules/static/static.service'
import { MachineRegistry } from './modules/tunnel/tunnel.service'

// Composition root: reads the environment, checks the accounts database when accounts are on, creates the registry,
// the forwarder, the bridge and the limiter, loads the built client, and starts the server.

let config: ReturnType<typeof loadServerConfig>
try {
  config = loadServerConfig(process.env)
} catch (error) {
  if (!(error instanceof ServerConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}

// The accounts modules of the server API, mounted only when accounts are on. None exists yet.
const accountsModules: ApiModule[] = []

if (config.accounts) {
  const domain = createDomain(config.accounts.databaseUrl)
  const problem = await checkDatabase(
    domain.skipAuthorization('start-up check of the connection and pending migrations'),
    databaseLocation(config.accounts.databaseUrl),
  )
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  console.log('accounts are on')
} else {
  console.log('DATABASE_URL is not set, so accounts are off')
}

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
const app = createApp({
  registry,
  forwarder,
  bridge,
  limiter,
  site,
  allowedOrigins,
  trustProxy,
  api: { trustedOrigins: config.trustedOrigins },
  accounts: config.accounts ? { modules: accountsModules } : null,
})
// The Bun server goes in as the env, which is where the client IP and socket upgrades come from.
const server = Bun.serve({
  hostname,
  port,
  fetch: (request, bunServer) => app.fetch(request, bunServer),
  websocket: serverWebSocket,
})
console.log(`server listening on http://${server.hostname}:${server.port}`)
