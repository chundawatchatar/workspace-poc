import { afterEach, beforeEach, type Mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { websocket } from '@hono/bun'
import {
  type AppState,
  decodeFrame,
  encodeFrame,
  type HostInfo,
  type MachineFrame,
  machineFrame,
  type ServerFrame,
  TUNNEL_PATH,
  wsPayloadBytes,
} from '@orch/shared'
import type { SessionManager, TermClient, TerminalSession } from '@orch/terminal'
import type { Server, ServerWebSocket } from 'bun'
import { type AppDeps, createApp } from './app'
import { tunnelEnv } from './lib/principal'
import { AccessKeyRepository } from './modules/access/access.repository'
import { AccessKeys, machineIdFromSecret } from './modules/access/access.service'
import { EventHub } from './modules/events/events.service'
import type { LayoutRepository } from './modules/layout/layout.repository'
import { DevicesRepository } from './modules/remote-access/devices.repository'
import { LinkedAccountRepository } from './modules/remote-access/linked-account.repository'
import { testRelayKey } from './modules/remote-access/relay-ticket.testing'
import { RemoteAccessRepository } from './modules/remote-access/remote-access.repository'
import { RemoteAccessService } from './modules/remote-access/remote-access.service'
import { TunnelClient } from './modules/tunnel/tunnel.service'

// Test-only harness for the host's sockets end to end: a real app, remote
// access service and tunnel client, wired as `index.ts` wires them and turned
// on by a saved setting, a fake server on one side, a stub session manager on
// the other, and the same app served locally to compare against. Each test
// file calls `useTunnelHarness()` once. Never imported by production code.

export const secret = `${'S'.repeat(42)}s`
/** The user id the fake server says owns every enrollment key, and the key it signs relay tickets with. */
export const ACCOUNT_ID = 'acct-ada-1'
export const relay = testRelayKey()
export const info: HostInfo = { home: '/home/me', shell: '/bin/zsh', platform: 'darwin', projectRoot: '/repo' }
export const OUTPUT = new Uint8Array([27, 91, 72, 104, 105])

/** A session manager with one terminal, which records what reaches it. */
function stubSessions() {
  const attached = new Set<TermClient>()
  const ensured: unknown[][] = []
  const inputs: string[] = []
  const session = {
    info: () => ({ id: 't1', alive: true }),
    attach(client: TermClient) {
      attached.add(client)
      client.send(JSON.stringify({ type: 'snapshot' }))
      client.send(OUTPUT)
    },
    detach: (client: TermClient) => attached.delete(client),
    input: (data: string) => inputs.push(data),
    claim: () => {},
  } as unknown as TerminalSession
  const sessions = {
    ensure: (...args: unknown[]) => {
      ensured.push(args)
      return session
    },
    get: () => session,
    list: () => [session],
    collect: () => false,
  } as unknown as SessionManager
  return { sessions, attached, ensured, inputs }
}

/** A machine socket as the fake server sees it. */
export interface Conn {
  ws: ServerWebSocket<unknown>
  frames: MachineFrame[]
}

export let server: Server<unknown>
export let local: Server<unknown>
export let tunnelApp: ReturnType<typeof createApp>['app']
export let conns: Conn[]
export let clients: TunnelClient[]
export let stub: ReturnType<typeof stubSessions>
export let hub: EventHub
let spies: Mock<(...args: unknown[]) => void>[]
export let dir: string
export let keys: AccessKeys
export let key: string
export let remoteAccess: RemoteAccessService
export let settingsFile: string

/** Starts the fake server, the host's app and its remote access before each test, and stops them after. */
export function useTunnelHarness() {
  beforeEach(setUp)
  afterEach(tearDown)
}

function setUp() {
  conns = []
  clients = []
  dir = mkdtempSync(join(tmpdir(), 'orch-access-'))
  stub = stubSessions()
  hub = new EventHub()
  spies = (['log', 'warn'] as const).map((level) => spyOn(console, level).mockImplementation(() => {}))
  const state: AppState = { rev: 1, workspaces: [] }
  const layout = {
    state,
    set: (next: AppState) => {
      layout.state = next
    },
  } as LayoutRepository

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === TUNNEL_PATH && server.upgrade(request, { data: undefined })) return
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        conns.push({ ws, frames: [] })
      },
      message(ws, data) {
        const conn = conns.find((c) => c.ws === ws)
        const frame = decodeFrame(machineFrame, data)
        if (!conn || !frame) return
        conn.frames.push(frame)
        if (frame.type === 'hello') send(conn, { type: 'welcome', machineId: machineIdFromSecret(secret) })
        if (frame.type === 'enroll.redeem') {
          const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
          const machineId = machineIdFromSecret(secret)
          const relayKeys = [relay.relayKey]
          send(conn, { type: 'enroll.redeemed', id: frame.id, machineId, accountId: ACCOUNT_ID, account, relayKeys })
        }
        // Like the server, it acks what it has delivered to the browser.
        if (frame.type === 'ws.data') {
          send(conn, { type: 'ws.ack', channel: frame.channel, bytes: wsPayloadBytes(frame.data) })
        }
      },
    },
  })

  const secretFile = join(dir, 'machine-secret')
  const keysFile = join(dir, 'access-keys.json')
  settingsFile = join(dir, 'remote-access.json')
  writeFileSync(secretFile, secret)
  key = new AccessKeys(new AccessKeyRepository(keysFile)).create('default')
  writeFileSync(
    settingsFile,
    JSON.stringify({ enabled: true, serverUrl: `ws://127.0.0.1:${server.port}`, clientUrl: 'https://orch.example' }),
  )
  remoteAccess = new RemoteAccessService({
    repository: new RemoteAccessRepository(settingsFile),
    linkedAccounts: new LinkedAccountRepository(join(dir, 'linked-account.json')),
    devices: new DevicesRepository(join(dir, 'devices.json')),
    secretFile,
    keysFile,
    handle: async (request, principal) => app.fetch(request, tunnelEnv(principal)),
    openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
    createTunnel: (options) => {
      const client = new TunnelClient({ ...options, timings: { baseMs: 10, maxMs: 10, authTimeoutMs: 100 } })
      clients.push(client)
      return client
    },
  })
  const { app, sockets } = createApp({
    hub,
    layout,
    sessions: stub.sessions,
    info,
    access: () => remoteAccess.current(),
    remoteAccess,
  } as unknown as AppDeps)
  tunnelApp = app
  local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })

  remoteAccess.start()
  const current = remoteAccess.current()
  if (!current) throw new Error('remote access did not start')
  keys = current.keys
}

async function tearDown() {
  remoteAccess.shutdown()
  for (const client of clients) client.stop()
  await server.stop(true)
  await local.stop(true)
  for (const spy of spies) spy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
}

export function send(conn: Conn, frame: ServerFrame) {
  conn.ws.send(encodeFrame(frame))
}

export async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(2)
  }
}

/** The first connection, once it is welcomed. */
export async function welcomed(): Promise<Conn> {
  await until(() => conns[0]?.frames.some((f) => f.type === 'hello') ?? false)
  const conn = conns[0]
  if (!conn) throw new Error('no connection')
  await Bun.sleep(5)
  return conn
}

/** The `ws.data` payloads sent on `channel`. */
export const dataOn = (conn: Conn, channel: number) =>
  conn.frames.flatMap((f) => (f.type === 'ws.data' && f.channel === channel ? [f.data] : []))

/** The auth message for `presented`. */
export const auth = (presented: string) => JSON.stringify({ type: 'auth', key: presented })

/** Opens a local socket and collects its text messages. */
export async function openLocal(path: string) {
  const messages: string[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${local.port}${path}`)
  ws.addEventListener('message', (event) => typeof event.data === 'string' && messages.push(event.data))
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  return { ws, messages }
}
