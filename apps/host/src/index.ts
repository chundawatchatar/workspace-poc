import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { websocket } from '@hono/bun'
import { HOST_PORT, type HostInfo } from '@orch/shared'
import { SessionManager, shellProgram } from '@orch/terminal'
import { createApp } from './app'
import { tunnelEnv } from './lib/principal'
import { AccessKeyRepository, accessKeysPath } from './modules/access/access.repository'
import {
  AccessKeys,
  clientUrlFromServerUrl,
  connectLink,
  DEFAULT_KEY_NAME,
  machineIdFromSecret,
  parseClientUrl,
  type RemoteAccess,
} from './modules/access/access.service'
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

let tunnel: TunnelClient | null = null
const remote = prepareRemote(process.env.SERVER_URL)

const { app, sockets } = createApp({
  hub,
  layout,
  sessions,
  info,
  daemonStartedAt: () => daemon.shared.startedAt,
  access: remote?.access ?? null,
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: HOST_PORT,
  fetch: app.fetch,
  websocket,
})
console.log(`host listening on http://${server.hostname}:${server.port}`)

if (remote && ensureKey(remote.access)) tunnel = startTunnel(remote)

/** What the tunnel needs, once `SERVER_URL`, the machine secret and the access keys have all checked out. */
interface Remote {
  url: string
  secret: string
  access: RemoteAccess
}

/**
 * Reads everything remote access needs when `SERVER_URL` is set: the tunnel
 * URL, the machine secret, the client URL and the access keys. Any problem
 * leaves the host running locally only.
 */
function prepareRemote(serverUrl: string | undefined): Remote | null {
  if (!serverUrl) return null
  const url = parseServerUrl(serverUrl)
  if (!url) {
    console.error(
      'SERVER_URL must be wss://<host>, or ws:// on 127.0.0.1, [::1] or localhost. Running without a tunnel',
    )
    return null
  }
  let secret: string
  let keys: AccessKeys
  try {
    secret = loadOrCreateMachineSecret(machineSecretFile(hostRoot))
    keys = new AccessKeys(new AccessKeyRepository(accessKeysPath(hostRoot)), {
      onRevoked: (keyIds) => tunnel?.closeChannels(keyIds),
    })
  } catch (error) {
    // The repositories' messages never contain the secret, a key or a hash.
    console.error(`no tunnel: ${error instanceof Error ? error.message : 'a secret file could not be read'}`)
    return null
  }
  let clientUrl = clientUrlFromServerUrl(serverUrl)
  const clientUrlSetting = process.env.CLIENT_URL
  if (clientUrlSetting) {
    const parsed = parseClientUrl(clientUrlSetting)
    if (parsed) clientUrl = parsed
    else console.error('CLIENT_URL must be an http:// or https:// URL. Ignoring it')
  }
  return { url, secret, access: { keys, machineId: machineIdFromSecret(secret), clientUrl } }
}

/**
 * Creates the `default` key on the first start and prints its connect link.
 * Only its hash is kept, so this is the one time it is shown. On later starts
 * it prints a hint instead. False when the key could not be saved.
 */
function ensureKey({ keys, machineId, clientUrl }: RemoteAccess): boolean {
  if (keys.size > 0) {
    console.log('remote access is on. Lost the connect link? Run `bun run host:rotate-key` for a new one')
    return true
  }
  let key: string
  try {
    key = keys.create(DEFAULT_KEY_NAME)
  } catch (error) {
    console.error(`no tunnel: the access key could not be saved (${error instanceof Error ? error.message : error})`)
    return false
  }
  const target = clientUrl
    ? `Connect link: ${connectLink(clientUrl, machineId, key)}`
    : `Machine id: ${machineId}\nAccess key: ${key}`
  console.log(
    `remote access key created. It will not be shown again; run \`bun run host:rotate-key\` for a new one.\n${target}`,
  )
  return true
}

/** Opens the tunnel to the server. Every request and socket it carries is checked by `authorize` first. */
function startTunnel({ url, secret, access }: Remote): TunnelClient {
  const client = new TunnelClient({
    url,
    secret,
    expectedMachineId: access.machineId,
    authorize: (key) => access.keys.authorize(key),
    handle: async (request, principal) => app.fetch(request, principal ? tunnelEnv(principal) : undefined),
    openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
  })
  client.start()
  return client
}

function shutdown() {
  clearInterval(inspector)
  tunnel?.stop()
  try {
    remote?.access.keys.flush()
  } catch (error) {
    console.error(`saving access key use failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  layout.flush()
  sessions.shutdown()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
