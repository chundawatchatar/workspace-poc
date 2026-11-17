import { afterEach, beforeEach, type Mock, spyOn } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Endpoint, TunnelState } from '@orch/shared'
import { type AppDeps, createApp } from '../../app'
import { localRequest } from '../../app.testing'
import type { Principal } from '../../lib/principal'
import { E2eSessions } from '../e2e/e2e.service'
import { readSettingsFile } from '../settings/settings.repository'
import { loadSettings } from '../settings/settings.service'
import type { TunnelClientOptions } from '../tunnel/tunnel.service'
import type {
  EnrollAnswer,
  EnrollRequest,
  EnrollStart,
  EnrollWaiting,
  UnlinkAnswer,
} from '../tunnel/tunnel-asks.service'
import type { OpenChannel } from '../tunnel/tunnel-channels.service'
import { devAddresses, type RemoteAccessEnv, type RemoteAddresses } from './addresses.service'
import { AuditLogRepository } from './audit-log.repository'
import { AuditLogService } from './audit-log.service'
import { DevicesRepository } from './devices.repository'
import { LinkedAccountRepository } from './linked-account.repository'
import { testRelayKey } from './relay-ticket.testing'
import { DEFAULT_SERVER_URL, RemoteAccessService } from './remote-access.service'

// Test-only harness for the remote access service: a temp dir, a fake tunnel
// and the service wired to them. Each test file calls
// `useRemoteAccessHarness()` once. Never imported by production code.

/** What a `FakeTunnel` was asked to send: `enroll.request`, or `unlink` with its account. */
export type SentAsk = EnrollRequest | { type: 'unlink'; accountId: string }

/** The server's first answer to `enroll.request`, before the fake tunnel adds the owner's answer to come. */
export type FirstAnswer = Omit<EnrollWaiting, 'answer'> | Extract<EnrollStart, { type: 'enroll.failed' }>

/**
 * How the fake server behind every `FakeTunnel` acts. Each test starts with
 * the defaults: reachable, holding every request for 15 minutes until the test
 * answers it, and removing whatever is unlinked.
 */
export interface FakeServer {
  /** False stands for a server that can't be reached: `whenConnected` rejects. */
  reachable: boolean
  /** Answers `enroll.request` first; a throw stands for a timeout or a lost tunnel. */
  request: (request: EnrollRequest) => FirstAnswer | Promise<FirstAnswer>
  /** The owner's answer to a request that waits, given at once; null leaves it for the test to give. */
  owner: ((machineId: string) => EnrollAnswer) | null
  /** Answers `unlink`; a throw stands for a timeout or a lost tunnel. */
  unlink: (accountId: string) => UnlinkAnswer
}

export let fakeServer: FakeServer

/** Stands in for `TunnelClient`, recording what the service asks of it and answering as `fakeServer` says. */
export class FakeTunnel {
  status: TunnelState = 'off'
  /** Every `closeChannels` call: which principals it matches, the reason and the close code, if one was given. */
  closed: { revoked: (principal: Principal) => boolean; reason: string; code?: number }[] = []
  constructor(readonly options: TunnelClientOptions) {}
  start() {
    this.status = 'connecting'
  }
  async whenConnected(_timeoutMs: number) {
    if (this.status === 'connected') return
    if (this.status !== 'connecting') throw new Error(`the tunnel is ${this.status}`)
    this.status = fakeServer.reachable ? 'connected' : 'reconnecting'
    if (!fakeServer.reachable) throw new Error('the tunnel is reconnecting')
  }
  /** The options of every `stop` call, in order: `{ remoteOff: true }` or undefined. */
  stops: ({ remoteOff: true } | undefined)[] = []
  stop(options?: { remoteOff: true }) {
    this.stops.push(options)
    this.status = 'off'
    this.drop()
  }
  /** The open, authorized channels it reports. `closeChannels` drops the ones it matches. */
  channels: OpenChannel[] = []
  closeChannels(revoked: (principal: Principal) => boolean, reason: string, code?: number) {
    this.closed.push({ revoked, reason, ...(code === undefined ? {} : { code }) })
    this.channels = this.channels.filter((channel) => !revoked(channel.principal))
  }
  listChannels() {
    return this.channels
  }
  /** Every frame that asks the server something, in order. */
  sent: SentAsk[] = []
  /** The owner's answer to the request that waits, until it comes or the tunnel goes. */
  private waiting: { resolve: (answer: EnrollAnswer) => void; reject: (error: Error) => void } | null = null
  async enroll(request: EnrollRequest): Promise<EnrollStart> {
    this.sent.push(request)
    const first = await fakeServer.request(request)
    if (first.type === 'enroll.failed') return first
    const answer = new Promise<EnrollAnswer>((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
    answer.catch(() => {})
    const owner = fakeServer.owner
    if (owner) setTimeout(() => this.answer(owner(this.machineId)), 0)
    return { ...first, answer }
  }
  /** Gives the owner's answer to the request that waits. */
  answer(frame: EnrollAnswer) {
    const waiting = this.waiting
    this.waiting = null
    waiting?.resolve(frame)
  }
  /** Accepts the request that waits, linking `machineId`, this machine's own unless given. */
  accept(machineId = this.machineId) {
    this.answer(accepted(machineId))
  }
  /** Ends the request that waits as a lost connection does. */
  drop() {
    const waiting = this.waiting
    this.waiting = null
    waiting?.reject(new Error('the tunnel closed'))
  }
  private get machineId() {
    return this.options.expectedMachineId ?? ''
  }
  async unlink(accountId: string) {
    this.sent.push({ type: 'unlink', accountId })
    return fakeServer.unlink(accountId)
  }
}

/** A base for fakes of the service that have no remote sessions; `remote-cli-sessions.test.ts` covers the command. */
export class NoRemoteSessions {
  listSessions = () => ({ sessions: [] })
  endSession = () => ({ sessions: [] })
}

export const key = `oek_${'k'.repeat(43)}`
export const email = 'ada.lovelace@example.com'
export const account = { name: 'Ada', maskedEmail: 'a***@example.com' }
/** The key owner's user id, as the server sends it in `enroll.redeemed`. */
export const accountId = 'acct-ada-1'
/** The server's relay signing key, whose public half it sends in `enroll.redeemed`. */
export const relay = testRelayKey('k1')
export const relayKeys = [relay.relayKey]
export const expiresAt = '2026-11-04T12:15:00.000Z'

/** How long the fake server holds a request by default: an enrollment key's 15 minutes. */
export const HOLD_MS = 15 * 60_000

/** The owner's accept of a request from `machineId`, as the server sends it. */
export function accepted(machineId: string): EnrollAnswer {
  return { type: 'enroll.redeemed', id: 1, machineId, accountId, account, relayKeys }
}

export let dir: string
export let tunnels: FakeTunnel[]
export let logs: string[]
let spies: Mock<(...args: unknown[]) => void>[]
export let service: RemoteAccessService
/** The end-to-end sessions the service closes, signed with its machine key. */
export let e2eSessions: E2eSessions

export const configFile = () => join(dir, 'config.json')
export const machineKeyFile = () => join(dir, 'machine-key')
export const linkedFile = () => join(dir, 'linked-account.json')
export const devicesFile = () => join(dir, 'devices.json')

/** Gives each test a temp dir and quiet console, and shuts the service down after. */
export function useRemoteAccessHarness() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-remote-'))
    fakeServer = {
      reachable: true,
      request: () => ({ type: 'enroll.waiting', id: 1, expiresInMs: HOLD_MS }),
      owner: null,
      unlink: () => ({ type: 'unlinked', id: 1 }),
    }
    tunnels = []
    logs = []
    spies = (['log', 'error', 'warn'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.join(' '))),
    )
  })

  afterEach(() => {
    service?.shutdown()
    for (const spy of spies) spy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })
}

/** What the data folder holds at start: a linked account, and the addresses in `config.json` that aren't null. */
export interface SavedSetup {
  /** True writes `linked-account.json`, linked through `serverUrl`, or the default when it is null. */
  linked?: boolean
  serverUrl?: string | null
}

/** The account a `linked` setup saves, linked through `serverUrl`. */
export function savedAccount(serverUrl: string) {
  return { ...account, serverUrl, linkedAt: expiresAt, accountId, relayKeys }
}

/** The addresses the dev host would start with from the temp dir's `config.json` and `env`. */
export function startAddresses(env: RemoteAccessEnv = {}, file = configFile()) {
  return devAddresses(loadSettings({ flags: {}, env: {}, file: readSettingsFile(file) }), env)
}

/**
 * Starts a service on the temp dir, with `saved` written first, or written as
 * it is to `linked-account.json` when it is a string, and `env` as the dev
 * host's environment. `addresses` replaces the ones loaded from the files and `env`.
 */
export function setup(
  saved: SavedSetup | string = {},
  env: RemoteAccessEnv = {},
  options: { addresses?: RemoteAddresses } = {},
) {
  if (typeof saved === 'string') writeFileSync(linkedFile(), saved)
  else {
    if (saved.serverUrl) writeFileSync(configFile(), JSON.stringify({ relayUrl: saved.serverUrl }))
    if (saved.linked) {
      const through = env.SERVER_URL || saved.serverUrl || DEFAULT_SERVER_URL
      writeFileSync(linkedFile(), JSON.stringify(savedAccount(through)))
    }
  }
  e2eSessions = new E2eSessions({ machineKey: () => service.signingKey() })
  service = new RemoteAccessService({
    linkedAccounts: new LinkedAccountRepository(linkedFile()),
    devices: new DevicesRepository(devicesFile()),
    audit: new AuditLogService(new AuditLogRepository(join(dir, 'remote-audit.jsonl'))),
    e2eSessions,
    machineKeyFile: machineKeyFile(),
    settingsFile: configFile(),
    addresses: options.addresses ?? startAddresses(env),
    handle: async () => new Response('ok'),
    openSocket: () => ({ code: 1008, reason: 'none' }),
    createTunnel: (options) => {
      const tunnel = new FakeTunnel(options)
      tunnels.push(tunnel)
      return tunnel
    },
  })
  service.start()
  const { app } = createApp({
    instanceId: 'test-instance',
    machinePublicKey: () => service.machinePublicKey(),
    remoteAccess: service,
  } as unknown as AppDeps)
  return app
}

/** Posts `body` to `endpoint` as a local caller and reads the answer. */
export async function post(app: ReturnType<typeof setup>, endpoint: Endpoint, body: unknown) {
  const response = await localRequest(app, endpoint.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) }
}

/**
 * A service connected to the account through a saved loopback address, whose
 * fake tunnel is connected. A linked account file already written is kept.
 */
export function connected() {
  const app = setup({ linked: !existsSync(linkedFile()), serverUrl: 'ws://127.0.0.1:4600' })
  const tunnel = tunnels[0]
  if (!tunnel) throw new Error('no tunnel')
  tunnel.status = 'connected'
  return { app, tunnel }
}
