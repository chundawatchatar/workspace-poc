import { afterEach, beforeEach, type Mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { websocket } from '@hono/bun'
import {
  ACCESS_KEY_HEADER,
  type AppState,
  DEVICE_PROOF_HEADER,
  decodeFrame,
  type E2eSocketMessage,
  type E2eSocketOpen,
  encodeFrame,
  type HostInfo,
  type MachineFrame,
  machineFrame,
  machineIdFromPublicKey,
  openE2eSessionResponse,
  RELAY_TICKET_HEADER,
  routes,
  type ServerFrame,
  startBrowserHandshake,
  TUNNEL_PATH,
  wsPayloadBytes,
} from '@orch/shared'
import type { SessionManager, TermClient, TerminalSession } from '@orch/terminal'
import type { Server, ServerWebSocket } from 'bun'
import { type AppDeps, createApp } from './app'
import { tunnelEnv } from './lib/principal'
import { AccessKeyRepository } from './modules/access/access.repository'
import { AccessKeys } from './modules/access/access.service'
import { E2eSessions } from './modules/e2e/e2e.service'
import { EventHub } from './modules/events/events.service'
import type { LayoutRepository } from './modules/layout/layout.repository'
import { AuditLogRepository } from './modules/remote-access/audit-log.repository'
import { AuditLogService } from './modules/remote-access/audit-log.service'
import { testDevice } from './modules/remote-access/device-proof.testing'
import { DevicesRepository } from './modules/remote-access/devices.repository'
import { LinkedAccountRepository } from './modules/remote-access/linked-account.repository'
import { testRelayKey } from './modules/remote-access/relay-ticket.testing'
import { RemoteAccessService } from './modules/remote-access/remote-access.service'
import { startAddresses } from './modules/remote-access/remote-access.testing'
import { TunnelClient } from './modules/tunnel/tunnel.service'
import {
  createTestMachineKey,
  helloVerifies,
  openMessages,
  openSealedReply,
  sealedEnvelope,
  sealedSocketEnvelope,
  sealMessage,
  testNonce,
} from './modules/tunnel/tunnel.testing'

// Test-only harness for the host's sockets end to end: a real app, remote
// access service and tunnel client, wired as `index.ts` wires them and
// connected by a saved account, a fake server on one side, a stub session
// manager on the other, and the same app served locally to compare against.
// Each test file calls `useTunnelHarness()` once. Never imported by production code.

/** The machine key the harness's host loads from its `machine-key` file, and the id the fake server derives from it. */
export const machineKey = createTestMachineKey()
export const machineId = await machineIdFromPublicKey(machineKey.publicKey)
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
  /** Every message the machine sent, as received. */
  raw: string[]
  /** The nonce of the `challenge` the fake server sent this socket. */
  nonce: string
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
/** The end-to-end sessions the harness's host keeps, as `index.ts` builds them. */
export let e2eSessions: E2eSessions
/** The host's `config.json`, which holds the fake server's address. */
export let settingsFile: string
/** The remote access audit log the harness's service writes. */
export const auditFile = () => join(dir, 'remote-audit.jsonl')
/** A browser approved on the machine before it starts, which signs the proofs that go with `key`. */
export let device: Awaited<ReturnType<typeof testDevice>>

/** Starts the fake server, the host's app and its remote access before each test, and stops them after. */
export function useTunnelHarness() {
  beforeEach(setUp)
  afterEach(tearDown)
}

async function setUp() {
  device = await testDevice()
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
        // Like the server, it challenges every socket and welcomes only a hello signed over that challenge.
        const nonce = testNonce()
        conns.push({ ws, frames: [], raw: [], nonce })
        ws.send(encodeFrame({ type: 'challenge', nonce }))
      },
      async message(ws, data) {
        const conn = conns.find((c) => c.ws === ws)
        if (!conn) return
        conn.raw.push(typeof data === 'string' ? data : Buffer.from(data).toString('latin1'))
        const frame = decodeFrame(machineFrame, data)
        if (!frame) return
        conn.frames.push(frame)
        if (frame.type === 'hello' && helloVerifies(frame, conn.nonce)) {
          send(conn, { type: 'welcome', machineId: await machineIdFromPublicKey(frame.publicKey) })
        }
        if (frame.type === 'enroll.redeem') {
          const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
          const relayKeys = [relay.relayKey]
          send(conn, { type: 'enroll.redeemed', id: frame.id, machineId, accountId: ACCOUNT_ID, account, relayKeys })
        }
        if (frame.type === 'unlink') send(conn, { type: 'unlinked', id: frame.id })
        // Like the server, it acks what it has delivered to the browser.
        if (frame.type === 'ws.data') {
          send(conn, { type: 'ws.ack', channel: frame.channel, bytes: wsPayloadBytes(frame.data) })
        }
      },
    },
  })

  const machineKeyFile = join(dir, 'machine-key')
  const keysFile = join(dir, 'access-keys.json')
  settingsFile = join(dir, 'config.json')
  writeFileSync(machineKeyFile, machineKey.pem, { mode: 0o600 })
  const approved = [{ id: device.id, publicKey: device.publicKey, approvedAt: new Date().toISOString() }]
  new DevicesRepository(join(dir, 'devices.json')).save(approved)
  key = new AccessKeys(new AccessKeyRepository(keysFile)).create('default')
  const serverUrl = `ws://127.0.0.1:${server.port}`
  writeFileSync(settingsFile, JSON.stringify({ relayUrl: serverUrl, clientUrl: 'https://orch.example' }))
  // Connected to the fake server's account, so the tunnel opens at start.
  const linkedAt = new Date().toISOString()
  const account = { name: 'Ada', maskedEmail: 'a***@example.com', serverUrl, linkedAt }
  writeFileSync(
    join(dir, 'linked-account.json'),
    JSON.stringify({ ...account, accountId: ACCOUNT_ID, relayKeys: [relay.relayKey] }),
  )
  e2eSessions = new E2eSessions({ machineKey: () => remoteAccess.signingKey() })
  remoteAccess = new RemoteAccessService({
    linkedAccounts: new LinkedAccountRepository(join(dir, 'linked-account.json')),
    devices: new DevicesRepository(join(dir, 'devices.json')),
    audit: new AuditLogService(new AuditLogRepository(auditFile())),
    e2eSessions,
    machineKeyFile,
    keysFile,
    settingsFile,
    addresses: startAddresses({}, settingsFile),
    handle: async (request, principal) => app.fetch(request, tunnelEnv(principal)),
    openSocket: (path, headers, conn, principal) => sockets.open(path, headers, conn, principal),
    createTunnel: (options) => {
      const client = new TunnelClient({ ...options, timings: { baseMs: 10, maxMs: 10 } })
      clients.push(client)
      return client
    },
  })
  const { app, sockets } = createApp({
    hub,
    layout,
    sessions: stub.sessions,
    info,
    instanceId: 'test-instance',
    machinePublicKey: () => remoteAccess.machinePublicKey(),
    access: () => remoteAccess.current(),
    remoteAccess,
    e2eSessions,
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

/** What a tunneled request or socket presents: an access key, or a relay ticket for the linked account. */
export type Presented = { key: string } | { ticket: string }

/** A browser that signs device proofs, as `testDevice` makes one. */
type Device = Awaited<ReturnType<typeof testDevice>>

/** A fresh relay ticket for the linked account on this machine, as the server signs one. */
export const accountTicket = () => relay.ticket({ sub: ACCOUNT_ID, aud: machineId })

/** The headers of a tunneled request presenting `as`, with a fresh proof from `who`. */
export async function credentialHeaders(
  as: Presented,
  method: string,
  path: string,
  body = '',
  who: Device = device,
): Promise<[string, string][]> {
  const proof = await who.proof({ machineId, method, path, body })
  const credential: [string, string] = 'key' in as ? [ACCESS_KEY_HEADER, as.key] : [RELAY_TICKET_HEADER, as.ticket]
  return [credential, [DEVICE_PROOF_HEADER, proof]]
}

/** The headers of a tunneled request with key `presented`, and a fresh proof from the approved `device`. */
export const keyHeaders = (presented: string, method: string, path: string, body = '') =>
  credentialHeaders({ key: presented }, method, path, body)

/** Opens a local socket and collects its text messages. */
export async function openLocal(path: string) {
  const messages: string[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${local.port}${path}`)
  ws.addEventListener('message', (event) => typeof event.data === 'string' && messages.push(event.data))
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  return { ws, messages }
}

/**
 * Opens an end-to-end session through `conn` as the browser does, presenting
 * `as` (the harness's `key` by default) from `who` (the approved `device`), as
 * tunneled request `id`. Returns the browser's side, the session id and
 * `next()`, which hands out the session's channels in order.
 */
export async function openE2eSession(conn: Conn, id: number, as: Presented = { key }, who: Device = device) {
  const { path, method } = routes.e2e.open
  const browser = await startBrowserHandshake({ machineId, device: who.signer })
  const hello = JSON.stringify(browser.hello)
  send(conn, {
    type: 'http.request',
    id,
    method,
    path,
    headers: [['content-type', 'application/json'], ...(await credentialHeaders(as, method, path, hello, who))],
    body: new TextEncoder().encode(hello),
  })
  const of = () => conn.frames.filter((f) => 'id' in f && f.id === id)
  await until(() => of().some((f) => f.type === 'http.end'))
  const body = Buffer.concat(of().flatMap((f) => (f.type === 'http.body' ? [f.data] : []))).toString()
  const opened = openE2eSessionResponse.parse(JSON.parse(body))
  let channels = 0
  return {
    session: await browser.finish(opened.hello, machineKey.publicKey),
    sessionId: opened.sessionId,
    next: () => ++channels,
  }
}

/** An end-to-end session as the browser holds it. */
export type BrowserSession = Awaited<ReturnType<typeof openE2eSession>>

/**
 * Sends `method path` sealed on the next channel of `e2e` as tunneled request
 * `id`, presenting `as` from `who` beside any other `headers`, and waits for its end. Returns the status
 * and body the browser reads: the sealed ones, or the unsealed ones for a
 * refusal the host couldn't seal.
 */
export async function sealedRequest(
  conn: Conn,
  e2e: BrowserSession,
  id: number,
  method: string,
  path: string,
  options: { as?: Presented; who?: Device; body?: string; headers?: [string, string][] } = {},
) {
  const { as = { key }, who = device, body } = options
  const headers = [...(options.headers ?? []), ...(await credentialHeaders(as, method, path, body, who))]
  const { channel, data } = await sealedEnvelope(e2e.session, e2e.sessionId, e2e.next(), {
    method,
    path,
    headers: body === undefined ? headers : [['content-type', 'application/json'], ...headers],
    ...(body === undefined ? {} : { body }),
  })
  send(conn, { type: 'http.sealed', id, data })
  const of = () => conn.frames.filter((f) => 'id' in f && f.id === id)
  await until(() => of().some((f) => f.type === 'http.end'))
  const outer = of().find((f) => f.type === 'http.response')
  const payloads = of().flatMap((f) => (f.type === 'http.body' ? [f.data] : []))
  if (outer?.type === 'http.response' && outer.status !== 200) {
    return { status: outer.status, body: Buffer.concat(payloads).toString() }
  }
  const reply = await openSealedReply(channel, payloads)
  return { status: reply.status, body: reply.body }
}

/**
 * Opens a sealed socket at `path` as tunnel channel `channel`, on the next
 * channel of `e2e`, presenting `as` from `who`. Returns the browser's end:
 * `send` seals a message onto it, and `messages` opens what the host sent so far.
 */
export async function sealedSocket(
  conn: Conn,
  e2e: BrowserSession,
  channel: number,
  path: string,
  options: { as?: Presented; who?: Device } = {},
) {
  const { as = { key }, who = device } = options
  const proof = await who.socket(machineId, path)
  const open: E2eSocketOpen =
    'key' in as
      ? { path, auth: { type: 'auth', key: as.key, device: proof } }
      : { path, auth: { type: 'auth', account: true, device: proof }, ticket: as.ticket }
  const { channel: e2eChannel, data } = await sealedSocketEnvelope(e2e.session, e2e.sessionId, e2e.next(), open)
  send(conn, { type: 'ws.sealed', channel, data })
  const opened: E2eSocketMessage[] = []
  return {
    /** Seals `message` onto the channel and sends it; returns its sealed size, as the host acks it. */
    send: async (message: E2eSocketMessage) => {
      const data = await sealMessage(e2eChannel, message)
      send(conn, { type: 'ws.data', channel, data })
      return data.byteLength
    },
    /** Every message the host sent on the channel, opened once each, in order. */
    messages: async () => {
      const payloads = dataOn(conn, channel)
      opened.push(...(await openMessages(e2eChannel, payloads.slice(opened.length))))
      return opened
    },
  }
}
